import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const source = ts.transpileModule(fs.readFileSync("lib/video-audio.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = { exports: {} };
vm.runInNewContext(source, {
  module: compiled, exports: compiled.exports, DataView, Uint8Array, DOMException, Error, Promise, String, Number, Math,
  require: (name) => {
    if (name === "./audio-client") return { SAMPLE_RATE: 24_000, toMonoAtRate: () => new Float32Array() };
    throw new Error(`Unexpected runtime dependency: ${name}`);
  },
});
const v = compiled.exports;
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

/** Build top-level boxes: [type, payloadLength, { large?: true, toEnd?: true }]. */
function file(boxes) {
  const parts = boxes.map(([type, payload, opts = {}]) => {
    const headerSize = opts.large ? 16 : 8;
    const bytes = new Uint8Array(headerSize + payload);
    const view = new DataView(bytes.buffer);
    if (opts.large) { view.setUint32(0, 1); view.setBigUint64(8, BigInt(headerSize + payload)); }
    else view.setUint32(0, opts.toEnd ? 0 : headerSize + payload);
    for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
    return bytes;
  });
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const reads = [];
  const readAt = async (offset, length) => { reads.push(length); return all.subarray(offset, offset + length); };
  return { size: all.length, readAt, reads };
}

test("video files are recognized by type or extension", () => {
  assert.equal(v.isVideoFile({ type: "video/mp4", name: "class.bin" }), true);
  assert.equal(v.isVideoFile({ type: "", name: "IMG_0042.MOV" }), true);
  assert.equal(v.isVideoFile({ type: "", name: "lesson.m4v" }), true);
  assert.equal(v.isVideoFile({ type: "audio/mp4", name: "lesson.m4a" }), false);
  assert.equal(v.isVideoFile({ type: "audio/webm" }), false);
});

test("top-level boxes are found from headers only, including a moov at the end", async () => {
  const f = file([["ftyp", 16], ["mdat", 5_000], ["moov", 300]]);
  const boxes = await v.scanTopLevelBoxes(f.size, f.readAt);
  same(boxes.map((b) => [b.type, b.offset, b.size]), [["ftyp", 0, 24], ["mdat", 24, 5_008], ["moov", 5_032, 308]]);
  assert.ok(f.reads.every((n) => n <= 16), "only headers are read");
});

test("64-bit and run-to-end box sizes are handled", async () => {
  const large = file([["ftyp", 8], ["mdat", 100, { large: true }], ["moov", 20]]);
  same((await v.scanTopLevelBoxes(large.size, large.readAt)).map((b) => b.type), ["ftyp", "mdat", "moov"]);
  const toEnd = file([["ftyp", 8], ["moov", 20], ["mdat", 64, { toEnd: true }]]);
  const boxes = await v.scanTopLevelBoxes(toEnd.size, toEnd.readAt);
  assert.equal(boxes.at(-1).type, "mdat");
  assert.equal(boxes.at(-1).offset + boxes.at(-1).size, toEnd.size);
});

test("a file that is not an MP4/MOV is rejected with a friendly message", async () => {
  const bytes = new TextEncoder().encode("RIFF....WAVEfmt this is a wav file not an mp4");
  await assert.rejects(v.scanTopLevelBoxes(bytes.length, async (o, n) => bytes.subarray(o, o + n)), (err) => {
    assert.equal(err.problem, "unsupported-format");
    assert.match(err.message, /MP4 and MOV/);
    return true;
  });
});

test("audio frames are read in bounded windows", () => {
  const samples = Array.from({ length: 10 }, (_, i) => ({ offset: i * 1_000, size: 200 }));
  const windows = v.planReadWindows(samples, 3_000);
  assert.ok(windows.every((w) => w.end - w.start <= 3_000));
  assert.equal(windows.flatMap((w) => w.samples).length, 10);
  same(windows.map((w) => [w.start, w.end]), [[0, 2_200], [3_000, 5_200], [6_000, 8_200], [9_000, 9_200]]);
  const big = v.planReadWindows([{ offset: 0, size: 10 }, { offset: 50, size: 9_999 }, { offset: 10_100, size: 10 }], 3_000);
  assert.equal(big.length, 3, "an oversized frame gets its own read");
});

test("problems carry plain-language messages for teachers", () => {
  const err = new v.VideoAudioError("unsupported-browser");
  assert.match(err.message, /latest Chrome or Edge, or upload just the audio/);
  assert.match(new v.VideoAudioError("no-audio").message, /no sound track/);
});
