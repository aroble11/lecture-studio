// Test call to Muse Voice Transcribe (realtime WebSocket ASR).
// Usage: node --env-file=.env.local test-transcribe.mjs test-audio/clip.wav
// The WAV must be 16-bit PCM, mono, 24 kHz. Node 22+ (global WebSocket).
// Optional speeds: --speeds=1,2,4 (multiples of real time; "max" = no pacing).
// Default runs 1 and max. Compares accuracy vs. speed for uploaded files.
import { readFileSync } from "node:fs";

const URL = "wss://api.meta.ai/v1/asr/realtime";
const MODEL = "muse-voice-transcribe-1.0";
const KEYWORDS = ["Articles of Confederation", "Shays' Rebellion", "Federalist Papers", "ratification", "Daniel Shays"];
const CHUNK_MS = 80;

if (typeof WebSocket === "undefined") {
  console.error("This script needs Node 22 or newer (global WebSocket). Run: node -v");
  process.exit(1);
}
const key = process.env.META_API_KEY;
if (!key) { console.error("META_API_KEY missing — run with --env-file=.env.local"); process.exit(1); }
const path = process.argv[2];
if (!path) { console.error("Pass a WAV path, e.g. test-audio/clip.wav"); process.exit(1); }

function readPcm(file) {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let off = 12, fmt, data;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV missing fmt or data chunk");
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 24000 || fmt.bits !== 16)
    throw new Error(`Need PCM 16-bit mono 24 kHz, got ${JSON.stringify(fmt)}`);
  return data;
}

function runSession(pcm, speed) {
    const paced = speed !== Infinity;
  return new Promise((resolve) => {
    const label = paced ? `SPEED ${speed}x` : "MAX (no pacing)";
    const t0 = Date.now(), ms = () => String(Date.now() - t0).padStart(6) + "ms";
    const seen = new Set(), finals = [];
    let lastProgress = 0, error = null;
    console.log(`\n===== Session: ${label} =====`);
    const ws = new WebSocket(URL);
    ws.binaryType = "arraybuffer";

    async function sendAudio() {
      const chunkBytes = 24000 * 2 * CHUNK_MS / 1000;
      for (let i = 0, n = 0; i < pcm.length; i += chunkBytes, n++) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (paced) { const wait = t0Audio + n * CHUNK_MS / speed - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); }
        ws.send(pcm.subarray(i, i + chunkBytes));
      }
      console.log(`${ms()}  [sent all audio, sending endStream]`);
      ws.send(JSON.stringify({ type: "endStream" }));
    }
    let t0Audio = 0, handshakeDone = false;

    ws.onopen = () => {
      console.log(`${ms()}  [connected, sending handshake]`);
      ws.send(JSON.stringify({
        mode: "ENDPOINTING", authorization: { accessToken: `Bearer ${key}` },
        audioEncoding: "PCM_24KHZ", model: MODEL, partialMode: "CUMULATIVE",
        emitAudioProgress: true, keywords: KEYWORDS, languageBias: ["English"],
      }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") { console.log(`${ms()}  [binary message ${ev.data.byteLength} bytes]`); return; }
      const msg = JSON.parse(ev.data);
      if (!handshakeDone) {
        handshakeDone = true;
        console.log(`${ms()}  HANDSHAKE RESPONSE: ${ev.data}`);
        if (msg.type === "error") { error = msg; return; }
        t0Audio = Date.now(); sendAudio();
        return;
      }
      const type = msg.type;
      if (type === "audioProgress") { lastProgress = msg.audioProcessedMs; if (!seen.has(type)) { seen.add(type); console.log(`${ms()}  first audioProgress: ${ev.data}`); } return; }
      if (!seen.has(type)) { seen.add(type); console.log(`${ms()}  FIRST "${type}" (full): ${ev.data}`); }
      else if (type !== "transcript") console.log(`${ms()}  ${type} turn=${msg.turnId} @audio ${lastProgress}ms${msg.transcript !== undefined ? `: ${msg.transcript}` : ""}`);
      if (type === "speechComplete") finals.push({ turn: msg.turnId, audioMs: lastProgress, text: msg.transcript });
      if (type === "error") error = msg;
    };
    let settled = false;
    const finish = (code, reason) => {
      if (settled) return; settled = true;
      console.log(`${ms()}  [closed code=${code} reason="${reason}"]`);
      resolve({ label, wallMs: Date.now() - t0, finals, error, closeCode: code });
    };
    ws.onerror = (e) => {
      console.log(`${ms()}  [socket error] ${e.message ?? ""}`);
      error ??= { socket: e.message ?? "error" };
      setTimeout(() => finish("none", "socket error"), 1000);
    };
    ws.onclose = (e) => finish(e.code, e.reason);
  });
}

const pcm = readPcm(path);
console.log(`Audio: ${(pcm.length / 48000).toFixed(1)} s`);
const results = [];
const arg = process.argv.find(a => a.startsWith("--speeds="));
const speeds = (arg ? arg.slice(9).split(",") : ["1", "max"]).map(v => v === "max" ? Infinity : Number(v));
for (const speed of speeds) results.push(await runSession(pcm, speed));

console.log("\n===== SUMMARY =====");
for (const r of results) {
  console.log(`\n${r.label}: wall ${(r.wallMs / 1000).toFixed(1)} s, close ${r.closeCode}${r.error ? `, ERROR ${JSON.stringify(r.error)}` : ""}`);
  for (const f of r.finals) console.log(`  [turn ${f.turn} ~${(f.audioMs / 1000).toFixed(1)}s] ${f.text}`);
  const words = r.finals.map(f => f.text).join(" ").toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const repeats = words.filter((w, i) => i > 0 && w === words[i - 1]);
  console.log(`  repeated words: ${repeats.length}${repeats.length ? ` (${repeats.join(", ")})` : ""}`);
}
