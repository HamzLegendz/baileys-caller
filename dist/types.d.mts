/**
 * Shared type definitions for baileys-caller.
 *
 * @author ShellTear
 */
/** Audio stream configuration reported by the WASM. */
export type AudioConfig = {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    framesPerChunk: number;
};
/** Options for placing a call. */
export type CallOptions = {
    /** Phone number, digits only (e.g. `"12345678901"`). */
    to: string;
    /** Audio source: file path to MP3/WAV, or `"silence"` for an empty uplink. */
    audioSource?: string;
    /** Auto-hangup after N ms (default: 120000). */
    durationMs?: number;
};
/** Events emitted by an `ActiveCall`. */
export type CallEvents = {
    ringing: () => void;
    connected: () => void;
    /** 16 kHz mono Float32 PCM frame from the remote peer. */
    audio: (pcm: Float32Array) => void;
    /** Reason: `"hangup"` | `"timeout"` | `"rejected"` | `"remote_end"` | `"disconnect"` | etc. */
    ended: (reason: string) => void;
    error: (err: Error) => void;
};
/** Auth method to use when connecting. */
export type AuthMethod = "qr" | "pairing";
/** Session storage backend. */
export type SessionBackend = "multifile" | "sqlite";
/** Top-level SDK configuration. */
export type VoipSdkConfig = {
    /**
     * Path to the auth storage.
     * - `multifile` backend → path to a **directory**
     * - `sqlite` backend    → path to a **file** (e.g. `"./session.db"`)
     */
    authDir: string;
    /**
     * Authentication method used when the session is new / expired.
     * - `"qr"`      → print a QR code to the terminal (default)
     * - `"pairing"` → request a numeric pairing code; requires `phoneNumber`
     */
    authMethod?: AuthMethod;
    /**
     * Phone number in international format **without** `+` or spaces,
     * e.g. `"628123456789"`. Required when `authMethod === "pairing"`.
     */
    phoneNumber?: string;
    /**
     * Session storage backend.
     * - `"multifile"` → Baileys default (JSON files) — default
     * - `"sqlite"`    → single SQLite database (better-sqlite3)
     */
    sessionBackend?: SessionBackend;
    /**
     * Called whenever the relay ICE round-trip time is measured.
     * Use this to display live connection quality to the user.
     * @param rttMs - Round-trip time in milliseconds
     */
    onIceRtt?: (rttMs: number) => void;
};
/** Mirrors the WhatsApp WASM `CallState` enum. */
export declare const CallState: {
    readonly Idle: 0;
    readonly Calling: 1;
    readonly PreacceptReceived: 2;
    readonly ReceivedCall: 3;
    readonly AcceptSent: 4;
    readonly AcceptReceived: 5;
    readonly Active: 6;
    readonly ActiveElsewhere: 7;
    readonly Ending: 13;
};
export type CallState = (typeof CallState)[keyof typeof CallState];
/** Relay list update payload from WASM call event 156. */
export type RelayListUpdate = {
    relay_key: string;
    relay_tokens: string[];
    auth_tokens?: string[];
    enable_edgeray_dtls_active_mode?: boolean;
    relays: ReadonlyArray<{
        relay_id: number;
        relay_name: string;
        token_id: number;
        auth_token_id?: number;
        addresses: ReadonlyArray<{
            protocol: number;
            ipv4?: string;
            ipv6?: string;
            port?: number;
            port_v6?: number;
        }>;
    }>;
};
