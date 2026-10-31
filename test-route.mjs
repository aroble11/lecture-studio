// Local test for POST /api/transcribe. Start the dev server first (npm run dev), then:
//   node test-route.mjs test-audio/clip.wav [--parallel=N]
// Sends the WAV's PCM (must be 16-bit mono 24 kHz) as one chunk with history keywords.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("Pass a WAV path, e.g. test-audio/clip.wav"); process.exit(1); }
const buf = readFileSync(file);
let off = 12, fmt, data;
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
  if (id === "fmt ") fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
  if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
  off += 8 + size + (size % 2);
}
if (!fmt || fmt.channels !== 1 || fmt.rate !== 24000 || fmt.bits !== 16) { console.error("Need 16-bit mono 24 kHz WAV", fmt); process.exit(1); }

const kws = ["Articles of Confederation", "Shays' Rebellion", "Daniel Shays", "Federalist Papers", "ratification"];
const url = "http://localhost:3000/api/transcribe?" + kws.map((k) => "kw=" + encodeURIComponent(k)).join("&");
const parallel = Number((process.argv.find((a) => a.startsWith("--parallel=")) ?? "--parallel=1").slice(11));
console.log(`POST ${(data.length / 1e6).toFixed(2)} MB (${(data.length / 48000).toFixed(1)} s audio) × ${parallel} at once…`);
const t0 = Date.now();
const results = await Promise.all(Array.from({ length: parallel }, async (_, i) => {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: data });
    const secs = (Date.now() - t0) / 1000;
    const text = await res.text();
    return { i, status: res.status, secs, bodySecs: (Date.now() - t0) / 1000, len: text.length, json: JSON.parse(text) };
  } catch (e) { return { i, status: "network error", secs: (Date.now() - t0) / 1000, json: { error: String(e) } }; }
}));
if (parallel === 1) {
  const r = results[0];
  console.log(`HTTP ${r.status} in ${r.secs.toFixed(1)} s`);
  console.log(JSON.stringify(r.json, null, 2));
} else {
  for (const r of results) {
    const words = r.json.turns ? r.json.turns.map((t) => t.text).join(" ").split(/\s+/).length : 0;
    console.log(`#${r.i + 1}: HTTP ${r.status} headers ${r.secs.toFixed(1)} s, body ${r.bodySecs?.toFixed(1)} s (${r.len} chars) — ${r.json.error ?? `${r.json.turns.length} turns, ${words} words`}`);
  }
  console.log(`All done in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${results.filter((r) => r.status === 200).length}/${parallel} succeeded`);
}
