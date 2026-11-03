import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const source = ts.transpileModule(fs.readFileSync("lib/board-frames.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = { exports: {} };
vm.runInNewContext(source, {
  module: compiled, exports: compiled.exports, Float32Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint8ClampedArray, Infinity, Math, Error,
  require: (name) => {
    if (name === "./image-client") return { prepareImage: () => { throw new Error("not in tests"); } };
    throw new Error(`Unexpected runtime dependency: ${name}`);
  },
});
const b = compiled.exports;
const times = (list) => JSON.stringify([...list]);

test("marker on a board is writing; a clean board is clean; a dark patterned shirt is hidden, not writing", () => {
  const w = 64, h = 64;
  const board = () => new Uint8ClampedArray(w * h * 4).fill(235);
  const paint = (img, x, y, v) => { const i = (y * w + x) * 4; img[i] = img[i + 1] = img[i + 2] = v; };
  const clean = board();
  const written = board();
  for (let y = 4; y < 60; y += 6) for (let x = 4; x < 60; x++) paint(written, x, y, 30); // thin marker lines
  const person = board();
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) paint(person, x, y, (x + y) % 3 === 0 ? 220 : 25);
  const count = (states, v) => [...states].filter((s) => s === v).length;
  assert.equal(count(b.patchStates(clean, w, h), b.CLEAN), 16);
  assert.equal(count(b.patchStates(written, w, h), b.WRITTEN), 16);
  assert.equal(count(b.patchStates(person, w, h), b.HIDDEN), 16);
});

/** A 100-patch board: `written` patches hold writing, `hidden` patches (from the end) are covered by a person. */
const frame = (seconds, written, hidden = 0) => {
  const states = new Int8Array(100).fill(b.CLEAN);
  for (let i = 0; i < written; i++) states[i] = b.WRITTEN;
  for (let i = 0; i < hidden; i++) states[99 - i] = b.HIDDEN;
  return { timeMs: seconds * 1000, states };
};
const lecture = (steps) => steps.map(([written, hidden], i) => frame(i * 5, written, hidden));

test("the fullest board before each erase and the final board are suggested", () => {
  const picked = b.pickBoardMoments(lecture([
    [0], [10], [20], [30], [40], [40], [40], // first board fills to 40 patches (30 s)
    [5], [15], [30], [45], [50], [50],       // erased, second board fills to 50 (60 s)
    [0], [10], [25], [30], [30],             // erased, final board of 30 (85 s)
  ]));
  assert.equal(times(picked), times([30_000, 60_000, 85_000]));
});

test("someone standing in front of the board is not an erase", () => {
  // Writing reaches 40 patches; then a person hides 70 patches (including some writing) and walks away.
  const picked = b.pickBoardMoments(lecture([[10], [20], [40], [40, 70], [40, 70], [40, 70], [45], [45], [45]]));
  assert.equal(picked.length, 1);
});

test("among frames of one board, the clearest view is chosen", () => {
  // The board is full from 10 s on; at 10–20 s a person covers 30 patches (not the writing); at 25 s the view is clear.
  const picked = b.pickBoardMoments(lecture([[10], [], [40, 30], [40, 30], [40, 30], [40], [40, 20]].map(([w = 0, h = 0]) => [w, h])));
  assert.equal(times(picked), times([25_000]));
});

test("an empty board suggests nothing, and small scribbles are skipped", () => {
  assert.equal(times(b.pickBoardMoments(lecture([[0], [0], [0]]))), "[]");
  assert.equal(times(b.pickBoardMoments([])), "[]");
  const picked = b.pickBoardMoments(lecture([[8], [8], [0], [0], [20], [40], [50], [50]]));
  assert.equal(times(picked), times([35_000]));
});

test("suggestions are capped and returned in time order", () => {
  const steps = [];
  for (let board = 0; board < 10; board++) steps.push([10], [30], [40 + board], [40 + board], [0]);
  const picked = b.pickBoardMoments(lecture(steps), { max: 4 });
  assert.equal(picked.length, 4);
  assert.equal(times(picked), times([...picked].sort((x, y) => x - y)));
});

test("long videos are skimmed with wider spacing", () => {
  assert.equal(b.sampleSpacingMs(7 * 60_000), 5_000);
  assert.equal(b.sampleSpacingMs(90 * 60_000), 9_000);
});

test("a moment is paired with the guided-notes section that covers its time", () => {
  const sections = [{ startSec: 0 }, { startSec: 120 }, { startSec: 300 }];
  assert.equal(b.sectionIndexForTime(sections, 30_000), 0);
  assert.equal(b.sectionIndexForTime(sections, 120_000), 1);
  assert.equal(b.sectionIndexForTime(sections, 299_000), 1);
  assert.equal(b.sectionIndexForTime(sections, 400_000), 2);
  assert.equal(b.sectionIndexForTime([{ startSec: 60 }], 10_000), 0, "before the first section → first section");
});

test("each suggested moment carries when its board began, so lifting never reaches back past an erase", () => {
  const picks = b.pickBoards(lecture([[0], [10], [40], [40], [5], [20], [50], [50]]));
  assert.equal(times(picks.map((p) => [p.timeMs, p.sinceMs])), times([[15_000, 0], [35_000, 20_000]]));
  const lift = b.liftTimes(35_000, 60_000, 20_000);
  assert.ok(lift.every((t) => t >= 20_000 && t <= 37_500), times(lift));
  assert.equal(lift[0], 35_000, "the moment itself comes first");
});

test("patches next to a person are treated as hidden", () => {
  const states = new Int8Array([0, 0, 0, 0, -1, 0, 0, 0, 0]);
  assert.equal(times([...b.growHidden(states, 3, 3)]), times([0, -1, 0, -1, -1, -1, 0, -1, 0]));
});

test("the crop covers the main drawing, not the board's frame or a far-off sign", () => {
  const cols = 12, rows = 6;
  const states = new Int8Array(cols * rows).fill(0);
  const everClean = new Uint8Array(cols * rows).fill(1);
  for (let c = 0; c < cols; c++) { states[c] = 1; everClean[c] = 0; } // the board's top frame: never clean
  for (let r = 2; r <= 3; r++) for (let c = 2; c <= 5; c++) states[r * cols + c] = 1; // the drawing
  states[3 * cols + 11] = 1; // a lone sign at the far edge
  assert.equal(JSON.stringify(b.writingBounds(states, cols, rows, everClean)), JSON.stringify({ c0: 1, r0: 1, c1: 6, r1: 4 }));
  assert.equal(b.writingBounds(new Int8Array(cols * rows), cols, rows, everClean), null);
});

test("cleaning keeps marker dark and turns the board and glare white", () => {
  const w = 32, h = 32, block = 16;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(225);
  const set = (x, y, v) => { const i = (y * w + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = v; };
  for (let x = 2; x < 30; x++) set(x, 8, 40);          // a marker line
  for (let y = 20; y < 28; y++) for (let x = 20; x < 28; x++) set(x, y, 255); // glare from a light
  const out = b.cleanBoard(rgba, w, h, block, new Int8Array(4).fill(0));
  const at = (x, y) => out[(y * w + x) * 4];
  assert.ok(at(10, 8) < 80, `marker stays dark (${at(10, 8)})`);
  assert.equal(at(10, 2), 255, "board is white");
  assert.equal(at(24, 24), 255, "glare is white");
  const hidden = b.cleanBoard(rgba, w, h, block, new Int8Array([-1, 0, 0, 0]));
  assert.equal(hidden[(8 * w + 4) * 4], 255, "a never-seen patch is white");
});

test("a camera pan is detected so misaligned frames aren't combined", () => {
  const w = 40, h = 30;
  const a = new Float32Array(w * h).fill(220);
  for (let y = 10; y < 20; y++) a[y * w + 15] = 30; // a vertical stroke
  const panned = new Float32Array(w * h).fill(220);
  for (let y = 10; y < 20; y++) panned[y * w + 18] = 30;
  const valid = new Uint8Array(w * h).fill(1);
  assert.equal(JSON.stringify(b.bestShift(a, a, w, h, valid)), JSON.stringify({ dx: 0, dy: 0 }));
  assert.equal(JSON.stringify(b.bestShift(a, panned, w, h, valid)), JSON.stringify({ dx: 3, dy: 0 }));
});
