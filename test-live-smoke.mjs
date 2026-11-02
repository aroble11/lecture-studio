// Manual paid-provider smoke test. Start the app first with `npm run dev`, then run:
//   npm run smoke:live -- --confirm-paid
// This file intentionally lives outside tests/ so `npm test` and CI cannot spend API credits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

if (!process.argv.includes("--confirm-paid")) {
  console.error("This command calls paid Meta and Baseten services. Re-run with --confirm-paid.");
  process.exit(2);
}

const argument = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baseUrl = argument("base-url", "http://localhost:3000").replace(/\/$/, "");
const audioPath = argument("audio", "test-audio/clip.wav");
const imagePath = argument("image", "test-images/pons_test.png");

function readPcmWav(file) {
  const wav = readFileSync(file);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF", "Audio fixture must be a RIFF WAV");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE", "Audio fixture must be a WAVE file");
  let offset = 12;
  let format;
  let pcm;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      format = {
        encoding: wav.readUInt16LE(offset + 8),
        channels: wav.readUInt16LE(offset + 10),
        rate: wav.readUInt32LE(offset + 12),
        bits: wav.readUInt16LE(offset + 22),
      };
    }
    if (id === "data") pcm = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  assert.deepEqual(format, { encoding: 1, channels: 1, rate: 24_000, bits: 16 }, "Audio must be PCM16 mono 24 kHz");
  assert.ok(pcm?.length, "Audio fixture has no PCM data");
  return pcm;
}

async function requestJson(label, route, init, timeoutMs) {
  const started = Date.now();
  console.log(`${label}...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${route}`, { ...init, signal: controller.signal });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); }
    catch { throw new Error(`${label} returned non-JSON HTTP ${response.status}`); }
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${body?.error ?? "unknown error"}`);
    console.log(`  passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const pcm = readPcmWav(audioPath);
const transcript = await requestJson(
  "[1/4] Meta transcription",
  "/api/transcribe?kw=Articles%20of%20Confederation&kw=Shays%27%20Rebellion",
  { method: "POST", headers: { "content-type": "application/octet-stream" }, body: pcm },
  110_000,
);
assert.ok(Array.isArray(transcript.turns) && transcript.turns.length > 0, "Transcription returned no turns");
assert.ok(transcript.turns.every((turn) => typeof turn.text === "string" && turn.text.trim()), "Transcription returned an invalid turn");
console.log(`  ${transcript.turns.length} transcript turns validated; content not printed`);

const extension = path.extname(imagePath).toLowerCase();
const mime = extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/png";
const image = `data:${mime};base64,${readFileSync(imagePath).toString("base64")}`;
const context = {
  subject: "Employability Skills",
  grade: "10",
  objective: "Explain professional workplace appearance",
  vocabulary: ["professionalism", "allowable", "unallowable"],
};
const diagram = await requestJson(
  "[2/4] Meta image planning and segmentation",
  "/api/label",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image, context }) },
  55_000,
);
assert.ok(diagram.kind === "objects" || diagram.kind === "mostly_text", "Labeling returned an invalid kind");
assert.ok(Array.isArray(diagram.items), "Labeling returned invalid items");
console.log(`  ${diagram.items.length} diagram items validated; labels not printed`);

const generationBody = {
  turns: transcript.turns,
  context,
  diagram: { summary: diagram.summary, items: diagram.items.map(({ n, label }) => ({ n, label })) },
};

async function verifyGeneration(label, privacy) {
  const output = await requestJson(
    label,
    "/api/generate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...generationBody, privacy }),
    },
    290_000,
  );
  assert.ok(output.materials, `${label} returned no materials`);
  assert.equal(output.materials.quiz?.length, 5, `${label} returned an incomplete quiz`);
  assert.equal(output.materials.diagramNotes?.length, diagram.items.length, `${label} returned incomplete diagram notes`);
  assert.equal(Boolean(output.privacy), privacy, `${label} returned the wrong provider-mode marker`);
  console.log(`  model=${output.model}; 5 quiz items and ${diagram.items.length} diagram notes validated; content not printed`);
}

await verifyGeneration("[3/4] Meta materials generation", false);
await verifyGeneration("[4/4] Baseten open-weight materials generation", true);

console.log("Live paid-provider smoke test passed. No transcript, labels, or generated content was printed or saved.");
