/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { WasmEngine } from "./wasm-engine.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig, AuthMethod, SessionBackend } from "./types.mjs";
export { CallState } from "./types.mjs";
export { useSQLiteAuthState } from "./sqlite-auth.mjs";
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    end: () => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;
    /** Change the audio source dynamically without ending the call. */
    changeAudioSource: (newSource: string) => void;
    /** Change the volume dynamically without ending the call. */
    changeVolume: (newVolume: number) => void;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
}
/** Top-level client. Connects to WhatsApp and lets you place calls. */
export declare class VoipClient extends EventEmitter {
    #private;
    constructor(config: VoipSdkConfig);
    /** Expose the underlying Baileys socket for external use (e.g. messaging). */
    get sock(): any;
    /** True once connect() has completed and WASM is ready. */
    get isReady(): boolean;
    /** True if a call is currently in progress. */
    get hasActiveCall(): boolean;
    /** Latest ICE round-trip time in ms. Null until first measurement. */
    get latestRttMs(): number | null;
    /** Force-clear the active call state (use when call ended but state stuck). */
    forceEndCall: () => void;
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
        volume?: number;
    }) => Promise<ActiveCall>;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => void;
}
