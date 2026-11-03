import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const source = ts.transpileModule(fs.readFileSync("lib/export-plan.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiled = { exports: {} };
vm.runInNewContext(source, { module: compiled, exports: compiled.exports, require: (n) => { throw new Error(`Unexpected runtime dependency: ${n}`); } });
const e = compiled.exports;

const materials = {
  guidedNotes: { title: "Binary", sections: [{ heading: "Place values", startSec: 0, items: [{ text: "Each place is worth _____ the one to its right.", answer: "ANSWER-twice" }] }], wordBank: ["twice"] },
  quiz: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, choices: ["a", "b", "c", "d"], answerIndex: 2, explanation: `EXPLANATION-${i}` })),
  exitTicket: [{ question: "Convert 5 to binary.", sampleAnswer: "SAMPLE-101" }],
  bellRinger: { prompt: "What is 1 + 1 in binary?", teacherNote: "TEACHERNOTE-look for 10" },
  diagramNotes: [{ n: 1, note: "DIAGRAMNOTE-ones place" }],
  pacingFeedback: ["PACING-slow down"],
  contentGaps: [{ concept: "GAP-overflow", atSec: 10, issue: "x", suggestion: "y" }],
};

test("the student copy carries no answers, explanations, sample answers, or teacher-only notes", () => {
  const text = JSON.stringify(e.forStudents(materials));
  for (const secret of ["ANSWER-", "EXPLANATION-", "SAMPLE-", "TEACHERNOTE-", "DIAGRAMNOTE-", "PACING-", "GAP-"]) {
    assert.ok(!text.includes(secret), `student copy leaked ${secret}`);
  }
  const student = e.forStudents(materials);
  assert.ok(student.quiz.every((q) => q.answerIndex === -1));
  assert.equal(student.guidedNotes.sections[0].items[0].text, materials.guidedNotes.sections[0].items[0].text);
  assert.equal(JSON.stringify(student.guidedNotes.wordBank), JSON.stringify(["twice"]), "the word bank is kept on purpose");
  assert.equal(materials.quiz[0].answerIndex, 2, "the original materials are not changed");
});

test("sections print in order; teacher feedback is only in the teacher copy", () => {
  assert.equal(JSON.stringify(e.printSections("student", { hasDiagram: false })), JSON.stringify(["guidedNotes", "quiz", "exitTicket", "bellRinger"]));
  assert.equal(JSON.stringify(e.printSections("teacher", { hasDiagram: true })), JSON.stringify(["guidedNotes", "labelPicture", "quiz", "exitTicket", "bellRinger", "teacherFeedback"]));
});
