/**
 * Example: login dengan Pairing Code + session SQLite, lalu buat panggilan.
 *
 * Usage:
 *   npx tsx examples/call-pairing.mts <phoneNumber> [targetNumber] [audioSource]
 *
 *   phoneNumber   Nomor WA kamu (format internasional, tanpa +): e.g. "628123456789"
 *   targetNumber  Nomor yang mau ditelepon                      (default: sama dengan phoneNumber)
 *   audioSource   Path ke MP3/WAV, atau "silence"              (default: silence)
 *
 * Environment:
 *   CALL_DURATION_MS   Auto-hangup setelah N ms               (default: 30000)
 *   SESSION_DB         Path ke file SQLite session             (default: ./session.db)
 *
 * @author HamzLegendz
 */
import { VoipClient } from "../src/index.mjs";

const [, , phoneNumber, targetNumber, audioSource = "silence"] = process.argv;
const durationMs  = Number(process.env.CALL_DURATION_MS) || 30_000;
const sessionDb   = process.env.SESSION_DB ?? "./session.db";

if (!phoneNumber) {
  console.error("Usage: npx tsx examples/call-pairing.mts <phoneNumber> [targetNumber] [audioSource]");
  console.error("  phoneNumber  : Nomor WA kamu, format internasional tanpa +, contoh: 628123456789");
  process.exit(1);
}

const callTarget = targetNumber ?? phoneNumber;

console.log(`📱 Nomor   : +${phoneNumber}`);
console.log(`🎯 Target  : +${callTarget}`);
console.log(`💾 Session : ${sessionDb}`);
console.log(`⏱  Durasi  : ${durationMs / 1000}s\n`);

const client = new VoipClient({
  authDir:        sessionDb,     // Path file SQLite
  sessionBackend: "sqlite",      // Gunakan SQLite (bukan multi-file)
  authMethod:     "pairing",     // Login pakai Pairing Code (bukan QR)
  phoneNumber,                   // Nomor WA untuk request pairing code
});

console.log("🔌 Menghubungkan ke WhatsApp...");
await client.connect();
console.log("✅ Terhubung!\n");

console.log(`📞 Memanggil +${callTarget}...`);
const call = await client.call(callTarget, { audioSource, durationMs });

call.on("ringing",   () => console.log("🔔 Berdering..."));
call.on("connected", () => console.log("📱 Panggilan tersambung!"));
call.on("ended",     (reason) => console.log(`📵 Panggilan berakhir: ${reason}`));
call.on("error",     (err)    => console.error("❌ Error:", err));

console.log(`🆔 Call ID: ${call.callId} | Auto-end dalam ${durationMs / 1000}s`);
await call.waitForEnd();

client.disconnect();
console.log("🔌 Terputus. Selesai.");
process.exit(0);
