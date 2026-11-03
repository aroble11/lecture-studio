import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const source = ts.transpileModule(fs.readFileSync("lib/lecture-workflow.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = { exports: {} };
vm.runInNewContext(source, {
  module: compiled, exports: compiled.exports, DOMException, Error,
  require: (name) => { throw new Error(`Unexpected runtime dependency: ${name}`); },
});
const w = compiled.exports;
// Values built inside the vm sandbox have that realm's prototypes; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

const lesson = { subject: "History", grade: "10", objective: "Explain federalism", standards: "" };
const turns = [
  { startMs: 0, endMs: 4000, text: "The Constitution  created three branches." },
  { startMs: 4000, endMs: 9000, text: "Federalism divides power." },
];

test("vocabulary splits on commas and new lines and drops blanks", () => {
  assert.deepEqual(plain(w.parseVocabulary(" Federalism, Shays' Rebellion\n\nratification ,, ")), ["Federalism", "Shays' Rebellion", "ratification"]);
  assert.deepEqual(plain(w.parseVocabulary("")), []);
});

test("lesson context combines lesson fields, vocabulary, and only the profile's guidance", () => {
  const context = w.buildLessonContext(lesson, "a, b", { style: "Socratic", classNotes: "ELL support", subject: "ignored" });
  assert.deepEqual(plain(context), { ...lesson, vocabulary: ["a", "b"], style: "Socratic", classNotes: "ELL support" });
  assert.deepEqual(plain(w.buildLessonContext(lesson, "", null)), { ...lesson, vocabulary: [] });
});

test("a result source is a deep copy that later edits cannot change", () => {
  const context = w.buildLessonContext(lesson, "a", null);
  const snapshot = w.snapshotResultSource(turns, 9000, context);
  turns[0].text = "edited";
  context.vocabulary.push("b");
  assert.equal(snapshot.turns[0].text, "The Constitution  created three branches.");
  assert.deepEqual(plain(snapshot.context.vocabulary), ["a"]);
  turns[0].text = "The Constitution  created three branches.";
});

test("older saved results get a rebuilt source; saves without results get none", () => {
  const saved = { turns, durationMs: 9000, lesson, keywords: "a", result: { materials: {} } };
  assert.deepEqual(plain(w.restoredResultSource(saved, { style: "s" })), {
    turns, durationMs: 9000, context: { ...lesson, vocabulary: ["a"], style: "s" },
  });
  const recorded = { turns: [], durationMs: 1, context: {} };
  assert.equal(w.restoredResultSource({ ...saved, resultSource: recorded }, null), recorded);
  assert.equal(w.restoredResultSource({ ...saved, result: null }, null), null);
});

test("diagram context includes only labeled items and only their number and label", () => {
  assert.equal(w.diagramContextFor(null), undefined);
  assert.equal(w.diagramContextFor({ kind: "mostly_text", summary: "Text", items: [] }), undefined);
  const labeled = { kind: "objects", summary: "A cell", items: [{ n: 1, label: "Nucleus", box: { x1: 0, y1: 0, x2: 1, y2: 1 } }] };
  assert.deepEqual(plain(w.diagramContextFor(labeled)), { summary: "A cell", items: [{ n: 1, label: "Nucleus" }] });
});

test("the generate request names the open-weight provider only when selected", () => {
  const source = { turns, durationMs: 9000, context: { subject: "History" } };
  assert.equal("privacy" in w.generateRequestBody(source, undefined, false), false);
  assert.equal(w.generateRequestBody(source, undefined, true).privacy, true);
  assert.deepEqual(plain(w.generateRequestBody(source, { summary: "s", items: [] }, false)), {
    turns, context: { subject: "History" }, diagram: { summary: "s", items: [] },
  });
});

test("kept transcription chunks resume only for the same audio and keywords", () => {
  const audio = {};
  const kept = { audio, keywords: w.keywordKey(["a", "b"]), results: ["chunk"] };
  assert.equal(w.resumableChunks(kept, audio, ["a", "b"]), kept.results);
  assert.equal(w.resumableChunks(kept, {}, ["a", "b"]), undefined);
  assert.equal(w.resumableChunks(kept, audio, ["a"]), undefined);
  assert.equal(w.resumableChunks(null, audio, []), undefined);
});

test("transcription errors explain unreadable audio and mention kept sections", () => {
  assert.match(w.transcriptionErrorMessage(new DOMException("bad", "EncodingError")), /couldn't read that audio file/);
  assert.equal(w.transcriptionErrorMessage(new Error("Timed out"), [undefined, undefined]), "Timed out");
  assert.equal(
    w.transcriptionErrorMessage(new Error("Busy."), [["turn"], undefined, ["turn"]]),
    "Busy. 2 of 3 sections are already done and kept — select Transcribe lecture to finish the rest.",
  );
  assert.equal(w.transcriptionErrorMessage("oops"), "Something went wrong.");
});

test("lecture length is checked against the limit with a formatted duration", () => {
  const format = (ms) => `${ms / 60_000} min`;
  assert.equal(w.lectureTooLongMessage(90 * 60_000, 90, format), null);
  assert.equal(w.lectureTooLongMessage(91 * 60_000, 90, format), "Lectures up to 90 minutes are supported; this one is 91 min.");
});

test("word counts ignore repeated spaces", () => {
  assert.equal(w.countWords(turns), 8);
  assert.equal(w.countWords([]), 0);
});

test("the save banner prioritizes errors, then warnings, then progress, then the size limit", () => {
  const idle = { kind: "idle" };
  const saved = { kind: "saved" };
  const tooLarge = { kind: "too-large", maxBytes: 100 * 1024 * 1024 };
  assert.deepEqual(plain(w.saveStatus(saved, saved, 0)), { message: "Saved in this browser.", attention: false, retry: false });
  assert.deepEqual(plain(w.saveStatus({ kind: "error", message: "Session failed." }, { kind: "error", message: "Audio failed." }, 0)),
    { message: "Session failed.", attention: true, retry: true });
  assert.equal(w.saveStatus(saved, { kind: "error", message: "Audio failed." }, 0).message, "Audio failed.");
  assert.deepEqual(plain(w.saveStatus(saved, { kind: "warning", message: "Recovered." }, 0)),
    { message: "Recovered.", attention: true, retry: false });
  assert.equal(w.saveStatus({ kind: "saving" }, idle, 0).message, "Saving this lecture in your browser…");
  assert.match(w.saveStatus({ kind: "saving" }, tooLarge, 0).message, /^Saving lecture details… The audio exceeds the 100 MB/);
  const done = w.saveStatus(saved, tooLarge, 150 * 1024 * 1024);
  assert.equal(done.message, "Lecture details are saved, but this 150.0 MB audio exceeds the 100 MB browser-save limit. It will not survive a refresh.");
  assert.equal(done.attention, true);
  assert.equal(done.retry, false);
});
