import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const compile = (file, require) => {
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, { module: compiled, exports: compiled.exports, require, Blob, console });
  return compiled.exports;
};
const store = compile("lib/session-store.ts", (name) => { throw new Error(`Unexpected runtime dependency: ${name}`); });
const { parseSampleLecture, SAMPLE_FORMAT, SAMPLE_URL } = compile("lib/sample-lecture.ts", (name) => {
  if (name === "./session-store") return store;
  throw new Error(`Unexpected runtime dependency: ${name}`);
});

const materials = {
  guidedNotes: { title: "Federalism", sections: [{ heading: "Levels of government", startSec: 0, items: [{ text: "Power is _____ between levels.", answer: "divided" }] }], wordBank: [] },
  quiz: Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i + 1}?`, choices: ["A", "B", "C", "D"], answerIndex: 0, explanation: "Because." })),
  exitTicket: [{ question: "What is federalism?", sampleAnswer: "Shared power." }],
  bellRinger: { prompt: "Name one level of government.", teacherNote: "Look for state or federal." },
  diagramNotes: [],
  pacingFeedback: [],
  contentGaps: [],
};
const sample = (overrides = {}) => ({
  format: SAMPLE_FORMAT,
  version: 1,
  title: "Federalism in five minutes",
  session: {
    version: 1,
    audioRevision: "some-old-revision",
    keywords: "Federalism",
    lesson: { subject: "U.S. History", grade: "10", objective: "", standards: "" },
    turns: [{ startMs: 0, endMs: 4000, text: "Federalism divides power between levels of government." }],
    durationMs: 4000,
    refImage: null,
    diagram: null,
    result: { materials: structuredClone(materials), model: "test-model", seconds: 12 },
    resultSource: null,
    resultDiagram: null,
    privacy: false,
  },
  ...overrides,
});

test("the sample is served from a fixed public path", () => {
  assert.equal(SAMPLE_URL, "/sample/sample-lecture.json");
});

test("a valid sample loads with materials and without stored audio", () => {
  const parsed = parseSampleLecture(sample());
  assert.equal(parsed.title, "Federalism in five minutes");
  assert.equal(parsed.session.result.materials.guidedNotes.title, "Federalism");
  assert.equal(parsed.session.audio, null);
  assert.equal(parsed.session.audioRevision, null);
  assert.equal(parsed.audio, undefined);
});

test("a sample without finished materials is rejected, so loading it can never call a provider", () => {
  const s = sample();
  s.session.result = null;
  assert.throws(() => parseSampleLecture(s), /no materials/);
});

test("damaged or unknown samples are rejected instead of partly shown", () => {
  assert.throws(() => parseSampleLecture(null), /invalid/);
  assert.throws(() => parseSampleLecture(sample({ format: "something-else" })), /unsupported/);
  assert.throws(() => parseSampleLecture(sample({ version: 2 })), /unsupported/);
  const broken = sample();
  broken.session.result.materials.quiz = broken.session.result.materials.quiz.slice(0, 3);
  assert.throws(() => parseSampleLecture(broken), /invalid parts|no materials/);
});

test("sample audio must be a recording beside the fixture", () => {
  const ok = parseSampleLecture(sample({ audio: { url: "/sample/sample-lecture.m4a", label: "Sample lecture.m4a" } }));
  assert.equal(ok.audio.url, "/sample/sample-lecture.m4a");
  assert.equal(ok.audio.label, "Sample lecture.m4a");
  for (const url of ["https://example.com/a.m4a", "/sample/../secret.m4a", "/sample/a.exe", "//evil/a.mp3"]) {
    assert.throws(() => parseSampleLecture(sample({ audio: { url, label: "x" } })), /audio is invalid/, url);
  }
});

test("a missing or oversized title falls back to a plain name", () => {
  assert.equal(parseSampleLecture(sample({ title: undefined })).title, "Sample lecture");
  assert.equal(parseSampleLecture(sample({ title: "x".repeat(121) })).title, "Sample lecture");
});
