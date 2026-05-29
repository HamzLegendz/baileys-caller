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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const LOW_WATERMARK_CHUNKS  = 32;   // Ring buffer pre-warm chunks (~640ms) to bypass connection latency
const MAX_QUEUED_CHUNKS     = 512;  // Maximum items stored in queue
const DEFAULT_WARMUP_MS     = 1000; // Accelerated warmup delay

export class AudioFeeder {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #pending = Buffer.alloc(0);
  #queue: Float32Array[] = [];
  #emitTimer: NodeJS.Timeout | null = null;
  #nextEmitAtMs = 0;
  #warmupUntilMs = 0;

  // Ring buffer index markers to speed up array operations and prevent GC thrashing
  #headIndex = 0;
  #tailIndex = 0;
  #ringBuffer: Float32Array[] = new Array(MAX_QUEUED_CHUNKS);

  droppedChunks   = 0;
  underflowChunks = 0;
  bytesProduced   = 0;
  chunksEmitted   = 0;

  constructor(
    private readonly sampleRate:     number,
    private readonly channels:       number,
    private readonly framesPerChunk: number,
    private readonly onChunk:        (chunk: Float32Array) => void,
    private readonly source:         string = "silence",
    private readonly volume:         number = 1.0,
  ) {}

  start = (): void => {
    if (this.#proc) return;

    const chunkSamples    = this.framesPerChunk * this.channels;
    const chunkBytes      = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
    const inputArgs       = this.#resolveInputArgs();

    // Volume level scaling boosted by 2.2x for louder playback
    const vol = Math.max(0.01, Math.min(3.0, this.volume));
    const scaledVol = vol * 2.2;

    // High fidelity anti-crackling filter pipeline:
    // 1. highpass=f=130 -> Eliminates boomy muddy bass rumble completely.
    // 2. volume -> High gain amplification.
    // 3. alimiter -> Soft-knee limiter to prevent clipping ("suara kresek") from high volume.
    // 4. aresample -> Fast, low-latency resampler (avoids CPU-heavy soxr which causes underflow on VPS).
    const afChain = [
      `highpass=f=130`,
      `volume=${scaledVol.toFixed(3)}`,
      `alimiter=level_in=1.0:level_out=0.98:limit=0.98:attack=5:release=80:asc=1:asc_level=0.5`,
      `aresample=${this.sampleRate}`,
    ].filter(Boolean).join(",");

    this.#proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",       "error",
      "-threads",        "1", // Explicit thread limiting to save CPU on shared core VPS hosting
      "-thread_queue_size", "2048",
      ...inputArgs,
      "-af",  afChain,
      "-f",   "f32le",
      "-ac",  String(this.channels),
      "-ar",  String(this.sampleRate),
      "pipe:1",
    ]);

    this.#proc.stdout.on("data", (chunk: Buffer) => {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      while (this.#pending.length >= chunkBytes) {
        const bufferedSize = (this.#tailIndex - this.#headIndex + MAX_QUEUED_CHUNKS) % MAX_QUEUED_CHUNKS;
        if (bufferedSize >= MAX_QUEUED_CHUNKS - 2) {
          this.#proc?.stdout.pause();
          break;
        }

        const frame  = this.#pending.subarray(0, chunkBytes);
        this.#pending = this.#pending.subarray(chunkBytes);
        const out    = new Float32Array(chunkSamples);
        out.set(new Float32Array(frame.buffer, frame.byteOffset, chunkSamples));
        
        this.bytesProduced += chunkBytes;

        // Push directly into pre-allocated ring buffer (avoids Array.push/Array.shift GC penalty)
        this.#ringBuffer[this.#tailIndex] = out;
        this.#tailIndex = (this.#tailIndex + 1) % MAX_QUEUED_CHUNKS;
      }
    });

    this.#proc.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line && !line.startsWith("size=") && !line.startsWith("frame=")) {
        process.stderr.write(`[AudioFeeder] ${line}\n`);
      }
    });

    this.#proc.on("exit", (code) => {
      this.#proc = null;
    });

    this.#nextEmitAtMs  = 0;
    this.#warmupUntilMs = Date.now() + DEFAULT_WARMUP_MS;
    this.#scheduleNext(chunkSamples, chunkIntervalMs);
  };

  stop = (): void => {
    if (this.#emitTimer) { clearTimeout(this.#emitTimer); this.#emitTimer = null; }
    this.#proc?.kill("SIGKILL");
    this.#proc     = null;
    this.#pending  = Buffer.alloc(0);
    this.#headIndex = 0;
    this.#tailIndex = 0;
    this.#ringBuffer = new Array(MAX_QUEUED_CHUNKS);
    this.#warmupUntilMs = 0;
  };

  #resolveInputArgs = (): string[] => {
    if (!this.source || this.source === "silence") {
      return ["-f", "lavfi", "-i", `aevalsrc=0:d=3600:s=${this.sampleRate}`];
    }
    if (this.source.startsWith("lavfi:")) {
      return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
    }
    return ["-i", this.source];
  };

  #scheduleNext = (chunkSamples: number, chunkIntervalMs: number): void => {
    if (!this.#proc && this.#headIndex === this.#tailIndex) return;
    const now = Date.now();
    if (this.#nextEmitAtMs === 0) this.#nextEmitAtMs = now;

    // Resync if the clock drifts too far behind due to VPS CPU steal/GC pauses
    if (now - this.#nextEmitAtMs > 100) {
      this.#nextEmitAtMs = now;
    }

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

  #flushOne = (chunkSamples: number): void => {
    if (this.#headIndex === this.#tailIndex) {
      // Buffer Underflow - emit silence chunk
      const silence = new Float32Array(chunkSamples);
      this.underflowChunks += 1;
      this.chunksEmitted += 1;
      this.onChunk(silence);
      return;
    }

    const nextChunk = this.#ringBuffer[this.#headIndex];
    this.#ringBuffer[this.#headIndex] = undefined as any; // clear reference
    this.#headIndex = (this.#headIndex + 1) % MAX_QUEUED_CHUNKS;

    this.chunksEmitted += 1;
    this.onChunk(nextChunk);

    const bufferedSize = (this.#tailIndex - this.#headIndex + MAX_QUEUED_CHUNKS) % MAX_QUEUED_CHUNKS;
    if (this.#proc?.stdout.isPaused() && bufferedSize <= MAX_QUEUED_CHUNKS / 4) {
      this.#proc.stdout.resume();
    }
  };
}
