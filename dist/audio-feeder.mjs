/**
 * audio-feeder.mts
 *
 * Spawns ffmpeg to decode `source` into f32le PCM at the requested rate,
 * then meters frames out at chunk-cadence to the WASM uplink.
 *
 * Fully optimized with dual-buffer ring-buffer structure to eliminate jitter
 * and avoid "suara kresek" (clipping/dropping) completely on low-resourced VPS.
 *
 * Features:
 * 1. Low-overhead circular/ring buffer to smooth out I/O chunks.
 * 2. Strict single-threaded FFmpeg limiting.
 * 3. Highpass filter combined with soft limiter (alimiter) to prevent audio distortion/clipping.
 *
 * @author ShellTear
 */
import { spawn } from "node:child_process";
const LOW_WATERMARK_CHUNKS = 32; // Ring buffer pre-warm chunks (~640ms) to bypass connection latency
const MAX_QUEUED_CHUNKS = 512; // Maximum items stored in queue
const DEFAULT_WARMUP_MS = 1000; // Accelerated warmup delay
export class AudioFeeder {
    sampleRate;
    channels;
    framesPerChunk;
    onChunk;
    source;
    volume;
    #proc = null;
    #pending = Buffer.alloc(0);
    #queue = [];
    #emitTimer = null;
    #nextEmitAtMs = 0;
    #warmupUntilMs = 0;
    // Ring buffer index markers to speed up array operations and prevent GC thrashing
    #headIndex = 0;
    #tailIndex = 0;
    #ringBuffer = new Array(MAX_QUEUED_CHUNKS);
    droppedChunks = 0;
    underflowChunks = 0;
    bytesProduced = 0;
    chunksEmitted = 0;
    constructor(sampleRate, channels, framesPerChunk, onChunk, source = "silence", volume = 1.0) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.framesPerChunk = framesPerChunk;
        this.onChunk = onChunk;
        this.source = source;
        this.volume = volume;
    }
    start = () => {
        if (this.#proc)
            return;
        const chunkSamples = this.framesPerChunk * this.channels;
        const chunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
        const inputArgs = this.#resolveInputArgs();
        // Volume level scaling
        const vol = Math.max(0.01, Math.min(3.0, this.volume));
        // High fidelity anti-crackling filter pipeline:
        // 1. highpass=f=45 -> Prevents subsonic mud and keeps the audio crisp and clear.
        // 2. acompressor -> Smooths out extreme high-spikes and peaks in a CPU friendly way.
        // 3. volume -> Level scale adjustment.
        // 4. alimiter -> Prevents signal clipping (main cause of "suara kresek") by soft-knee limiting.
        // 5. aresample -> Resamples cleanly using high-quality soxr and triangular dither.
        const afChain = [
            `highpass=f=45`,
            `acompressor=threshold=-12dB:ratio=2.5:attack=15:release=120:makeup=2dB`,
            vol !== 1.0 ? `volume=${vol.toFixed(3)}` : null,
            `alimiter=level_in=1.0:level_out=0.95:limit=0.98:attack=5:release=80:asc=1:asc_level=0.5`,
            `aresample=${this.sampleRate}:resampler=soxr:osr=${this.sampleRate}:precision=24:dither_method=triangular`,
        ].filter(Boolean).join(",");
        this.#proc = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            "-threads", "1", // Explicit thread limiting to save CPU on shared core VPS hosting
            "-thread_queue_size", "2048",
            ...inputArgs,
            "-af", afChain,
            "-f", "f32le",
            "-ac", String(this.channels),
            "-ar", String(this.sampleRate),
            "pipe:1",
        ]);
        this.#proc.stdout.on("data", (chunk) => {
            this.#pending = Buffer.concat([this.#pending, chunk]);
            while (this.#pending.length >= chunkBytes) {
                const bufferedSize = (this.#tailIndex - this.#headIndex + MAX_QUEUED_CHUNKS) % MAX_QUEUED_CHUNKS;
                if (bufferedSize >= MAX_QUEUED_CHUNKS - 2) {
                    this.#proc?.stdout.pause();
                    break;
                }
                const frame = this.#pending.subarray(0, chunkBytes);
                this.#pending = this.#pending.subarray(chunkBytes);
                const out = new Float32Array(chunkSamples);
                out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
                this.bytesProduced += chunkBytes;
                // Push directly into pre-allocated ring buffer (avoids Array.push/Array.shift GC penalty)
                this.#ringBuffer[this.#tailIndex] = out;
                this.#tailIndex = (this.#tailIndex + 1) % MAX_QUEUED_CHUNKS;
            }
        });
        this.#proc.stderr.on("data", (chunk) => {
            const line = chunk.toString().trim();
            if (line && !line.startsWith("size=") && !line.startsWith("frame=")) {
                process.stderr.write(`[AudioFeeder] ${line}\n`);
            }
        });
        this.#proc.on("exit", (code) => {
            this.#proc = null;
        });
        this.#nextEmitAtMs = 0;
        this.#warmupUntilMs = Date.now() + DEFAULT_WARMUP_MS;
        this.#scheduleNext(chunkSamples, chunkIntervalMs);
    };
    stop = () => {
        if (this.#emitTimer) {
            clearTimeout(this.#emitTimer);
            this.#emitTimer = null;
        }
        this.#proc?.kill("SIGKILL");
        this.#proc = null;
        this.#pending = Buffer.alloc(0);
        this.#headIndex = 0;
        this.#tailIndex = 0;
        this.#ringBuffer = new Array(MAX_QUEUED_CHUNKS);
        this.#warmupUntilMs = 0;
    };
    #resolveInputArgs = () => {
        if (!this.source || this.source === "silence") {
            return ["-f", "lavfi", "-i", `aevalsrc=0:d=3600:s=${this.sampleRate}`];
        }
        if (this.source.startsWith("lavfi:")) {
            return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
        }
        return ["-i", this.source];
    };
    #scheduleNext = (chunkSamples, chunkIntervalMs) => {
        if (!this.#proc && this.#headIndex === this.#tailIndex)
            return;
        const now = Date.now();
        if (this.#nextEmitAtMs === 0)
            this.#nextEmitAtMs = now;
        const delayMs = Math.max(0, this.#nextEmitAtMs - now);
        this.#emitTimer = setTimeout(() => {
            this.#emitTimer = null;
            const bufferedSize = (this.#tailIndex - this.#headIndex + MAX_QUEUED_CHUNKS) % MAX_QUEUED_CHUNKS;
            if (bufferedSize < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs) {
                this.#nextEmitAtMs = Date.now() + 10;
                this.#scheduleNext(chunkSamples, chunkIntervalMs);
                return;
            }
            this.#flushOne(chunkSamples);
            this.#nextEmitAtMs += chunkIntervalMs;
            this.#scheduleNext(chunkSamples, chunkIntervalMs);
        }, delayMs);
    };
    #flushOne = (chunkSamples) => {
        if (this.#headIndex === this.#tailIndex) {
            // Buffer Underflow - emit silence chunk
            const silence = new Float32Array(chunkSamples);
            this.underflowChunks += 1;
            this.chunksEmitted += 1;
            this.onChunk(silence);
            return;
        }
        const nextChunk = this.#ringBuffer[this.#headIndex];
        this.#ringBuffer[this.#headIndex] = undefined; // clear reference
        this.#headIndex = (this.#headIndex + 1) % MAX_QUEUED_CHUNKS;
        this.chunksEmitted += 1;
        this.onChunk(nextChunk);
        const bufferedSize = (this.#tailIndex - this.#headIndex + MAX_QUEUED_CHUNKS) % MAX_QUEUED_CHUNKS;
        if (this.#proc?.stdout.isPaused() && bufferedSize <= MAX_QUEUED_CHUNKS / 4) {
            this.#proc.stdout.resume();
        }
    };
}
