# baileys-caller

Place WhatsApp voice calls from Node.js with ultra-premium audio quality and dynamic stream controls.

Wraps WhatsApp Web's official VoIP WASM stack and uses [Baileys](https://github.com/WhiskeySockets/Baileys) for authentication and signaling. Audio (MP3, WAV, or `Float32Array`) is encoded with Opus and sent over the live RTP session.

> **Author:** ShellTear
> **Optimizations & Upgrades:** HamzLegendz

## Status

- ✅ Outbound 1:1 voice calls
- ✅ Stream audio from MP3/WAV files
- ✅ **Dynamic Audio Hot-Swapping** (Switch audio files/streams on-the-fly without hanging up!)
- ✅ **Dynamic Volume Scale Control** (Adjust digital volume gain dynamically mid-call!)
- ✅ **High-Fidelity Audio Limiter** (Built-in standard `alimiter` dynamic ceiling to prevent digital clipping/distortion)
- ✅ **Pre-allocated Memory Circular Ring Buffer** (Zero GC latency & Zero VPS CPU spikes)
- ✅ Receive remote audio as `Float32Array`
- ✅ Mute / unmute / hang up
- ❌ Group calls
- ❌ Video
- ❌ Inbound calls

## Requirements

- Node.js ≥ 20
- `ffmpeg` on `PATH` (used to decode/resample audio sources with low-overhead threads)
- A linked WhatsApp account (supports pairing code or QR scan auth)

## Install

This package isn't published on npm. Pull it in directly from git:

```bash
git clone https://github.com/SheIITear/baileys-caller
cd baileys-caller
npm install
npm run build
```

You can also depend on it from another project via a git URL in `package.json`:

```json
{
  "dependencies": {
    "baileys-caller": "git+https://github.com/SheIITear/baileys-caller.git",
    "@whiskeysockets/baileys": "^7.0.0-rc11"
  }
}
```

`@whiskeysockets/baileys` is a peer dependency — install it in your project alongside this one.

## Quick Start

```ts
import { VoipClient } from "baileys-caller";

const client = new VoipClient({ 
  authDir: "./auth",
  sessionBackend: "sqlite",
});

await client.connect(); 

// Place a call with dynamic options
const call = await client.call("6283148888114", {
  audioSource: "./song1.mp3",
  volume: 1.0, // Scale volume 0.1 - 2.0
});

call.on("ringing",   () => console.log("ringing"));
call.on("connected", () => console.log("connected"));
call.on("ended",     (reason) => console.log("ended:", reason));

// Hot-swap audio dynamic stream without closing the call!
setTimeout(() => {
  call.changeAudioSource("./song2.mp3");
}, 10000);

// Adjust volume dynamic gain mid-call!
setTimeout(() => {
  call.changeVolume(1.5);
}, 20000);

await call.waitForEnd();
client.disconnect();
```

## API Reference

### `new VoipClient(options)`

| Option | Type | Description |
|---|---|---|
| `authDir` | `string` | Baileys multi-file state directory or SQLite DB path |
| `sessionBackend` | `"multifile" \| "sqlite"` | SQLite backend is recommended for instant startup speed |
| `authMethod` | `"pairing" \| "qr"` | Supports numeric pairing code or QR code display |
| `phoneNumber` | `string` | Pairing phone number (digits only, e.g. `"6283148888114"`) |
| `onIceRtt` | `(rttMs: number) => void` | Event handler called when ICE roundtrip network latency is measured |

### `client.call(phoneNumber, opts?): Promise<ActiveCall>`

Places an outbound call. `phoneNumber` is digits only (e.g. `"6283148888114"`).

| Option | Type | Description |
|---|---|---|
| `audioSource` | `string \| "silence"` | Path to MP3/WAV, or `"silence"` for an empty stream |
| `durationMs` | `number?` | Auto-hangup limit |
| `volume` | `number?` | Initial volume gain scaling (0.1 to 2.0) |

### `ActiveCall`

Returned by `client.call()`. Extends `EventEmitter`.

#### Methods

- `call.end(): void` — Hang up.
- `call.mute(muted: boolean): void` — Toggle outgoing mute.
- `call.changeAudioSource(newSource: string): void` — Hot-swap audio feed instantly mid-call.
- `call.changeVolume(newVolume: number): void` — Change digital volume scaling dynamically.
- `call.waitForEnd(): Promise<string>` — Resolves with ending reason.

#### Properties

- `call.callId: string`

## Architecture Highlights

1. **Circular Ring Buffer**: Garbage-collection-free memory ring queue that eliminates standard arrays GC overhead under heavy I/O workloads, protecting shared core VPS machines from CPU hikes.
2. **Audio Peak Limiter (`alimiter`)**: Audio pipeline configured with highpass filtering (45Hz) and soft-knee limiter ceilings to guarantee absolute clarity and completely avoid digital clipping ("suara kresek").
3. **Optimized WASM Worker Pool**: Startup threads pruned from 6 to 3 to achieve super fast boot time (<1s) and low hardware footprint.

## License

MIT © ShellTear
