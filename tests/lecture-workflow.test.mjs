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

const turn = (startMs, text) => ({ startMs, endMs: startMs + 4_000, text });
const json = (v) => JSON.stringify(v);

test("transcript edits are tidied, keep their times, and drop emptied segments", () => {
  const turns = [turn(0, "Binary uses two digits."), turn(4_000, "Decimel uses ten."), turn(8_000, "Um.")];
  const edited = w.applyTranscriptEdits(turns, ["Binary uses two digits.", "  Decimal   uses ten. ", "   "]);
  assert.equal(json(edited), json([turn(0, "Binary uses two digits."), turn(4_000, "Decimal uses ten.")]));
  assert.equal(turns[1].text, "Decimel uses ten.", "the original transcript is not changed");
  assert.equal(w.applyTranscriptEdits(turns, ["", "", ""]).length, 1, "at least one segment always stays");
  assert.equal(w.applyTranscriptEdits([turn(0, "a")], ["x".repeat(20_000)])[0].text.length, w.MAX_SEGMENT_CHARS);
});

test("materials are flagged as outdated only when the transcript they came from was edited", () => {
  const turns = [turn(0, "One."), turn(4_000, "Two.")];
  assert.equal(w.materialsOutdated(turns, { turns: turns.map((t) => ({ ...t })) }), false);
  assert.equal(w.materialsOutdated(w.applyTranscriptEdits(turns, ["One!", "Two."]), { turns }), true);
  assert.equal(w.materialsOutdated(turns, null), false, "no materials, nothing to flag");
});

const item = (n, label, box) => ({ n, label, phrase: label, box, score: 1 });

test("moving a numbered marker carries its box and keeps it on the picture", () => {
  const moved = w.moveDiagramItem(item(1, "ones place", { x1: 100, y1: 100, x2: 200, y2: 150 }), 500.4, 600.6);
  assert.equal(json(moved.box), json({ x1: 500, y1: 601, x2: 600, y2: 651 }));
  const edge = w.moveDiagramItem(item(1, "x", { x1: 0, y1: 0, x2: 100, y2: 100 }), 990, -20);
  assert.equal(json(edge.box), json({ x1: 900, y1: 0, x2: 1000, y2: 100 }));
});

test("renaming a label trims it, ignores blanks, and leaves other labels alone", () => {
  const items = [item(1, "speaker", { x1: 0, y1: 0, x2: 1, y2: 1 }), item(2, "table", { x1: 0, y1: 0, x2: 1, y2: 1 })];
  const renamed = w.renameDiagramItem(items, 1, "   ones   place ");
  assert.equal(json(renamed.map((i) => i.label)), json(["ones place", "table"]));
  assert.equal(w.renameDiagramItem(items, 1, "   "), items);
  assert.equal(w.renameDiagramItem(items, 2, "y".repeat(100))[1].label.length, w.MAX_LABEL_CHARS);
});

test("adding a label takes the next number, lands on the picture, and stops at six", () => {
  const box = { x1: 0, y1: 0, x2: 1, y2: 1 };
  let items = [item(1, "rotor", box), item(2, "stator", box)];
  items = w.addDiagramItem(items);
  assert.equal(json(items.map((i) => i.n)), json([1, 2, 3]));
  assert.equal(items[2].label, "Label 3");
  for (let k = 0; k < 10; k++) items = w.addDiagramItem(items);
  assert.equal(items.length, w.MAX_DIAGRAM_ITEMS);
  assert.equal(w.addDiagramItem(items), items, "a full picture is unchanged");
  for (const added of items.slice(2)) {
    assert.ok(added.box.x1 >= 0 && added.box.x2 <= 1000 && added.box.y1 >= 0 && added.box.y2 <= 1000);
    assert.ok(added.box.x2 > added.box.x1 && added.box.y2 > added.box.y1);
  }
  assert.equal(new Set(items.map((i) => `${i.box.x1},${i.box.y1}`)).size >= 4, true, "added markers don't stack");
});

test("removing a label renumbers the rest in order and never removes the last one", () => {
  const box = { x1: 0, y1: 0, x2: 1, y2: 1 };
  const items = [item(1, "a", box), item(2, "b", box), item(3, "c", box), item(4, "d", box)];
  const removed = w.removeDiagramItem(items, 2);
  assert.equal(json(removed.map((i) => [i.n, i.label])), json([[1, "a"], [2, "c"], [3, "d"]]));
  assert.equal(w.removeDiagramItem(items, 9), items, "an unknown number changes nothing");
  const one = [item(1, "only", box)];
  assert.equal(w.removeDiagramItem(one, 1), one, "a drawing keeps at least one label");
});

test("saved lectures accept as many labels as the editor allows", () => {
  const store = fs.readFileSync("lib/session-store.ts", "utf8");
  assert.match(store, new RegExp(`array\\(diagram\\.items, \`\\$\\{field\\}\\.items\`, ${w.MAX_DIAGRAM_ITEMS}\\)`));
  assert.match(store, new RegExp(`number\\(item\\.n, \`\\$\\{field\\}\\.items\\[\\$\\{i\\}\\]\\.n\`, 1, ${w.MAX_DIAGRAM_ITEMS}, true\\)`));
});

test("only whiteboard drawings can add or remove labels; the picture activity keeps its generated notes in step", () => {
  const materials = fs.readFileSync("app/components/MaterialsView.tsx", "utf8");
  const diagramView = fs.readFileSync("app/components/DiagramView.tsx", "utf8");
  const editor = fs.readFileSync("app/components/LabelEditor.tsx", "utf8");
  assert.match(materials, /<LabelEditor src=\{moment\.image\.dataUrl\}[^>]*canAddRemove/);
  assert.doesNotMatch(diagramView, /canAddRemove/);
  assert.match(editor, /Type a name for number \$\{blank\.n\}/, "a blank name blocks Done instead of saving a blank");
});
