import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function loadRevisionGate() {
  const source = ts.transpileModule(fs.readFileSync("lib/operation-revision.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, { module: compiled, exports: compiled.exports, AbortController });
  return compiled.exports.createOperationRevision;
}

test("invalidating a lecture aborts every active operation and expires their tickets", () => {
  const gate = loadRevisionGate()();
  const transcription = gate.begin();
  const generation = gate.begin();
  assert.equal(gate.isCurrent(transcription), true);
  assert.equal(gate.isCurrent(generation), true);

  assert.equal(gate.invalidate(), 1);
  assert.equal(transcription.controller.signal.aborted, true);
  assert.equal(generation.controller.signal.aborted, true);
  assert.equal(gate.isCurrent(transcription), false);
  assert.equal(gate.isCurrent(generation), false);
});

test("a replacement operation is current while a late response from the prior revision is ignored", async () => {
  const gate = loadRevisionGate()();
  const old = gate.begin();
  const late = Promise.resolve("old lecture");
  gate.invalidate();
  const current = gate.begin();

  const oldValue = await late;
  assert.equal(oldValue, "old lecture");
  assert.equal(gate.isCurrent(old), false);
  assert.equal(gate.isCurrent(current), true);
});

test("finishing removes a ticket without changing the lecture revision", () => {
  const gate = loadRevisionGate()();
  const ticket = gate.begin();
  const revision = gate.revision();
  gate.finish(ticket);
  assert.equal(gate.revision(), revision);
  assert.equal(gate.isCurrent(ticket), false);
  assert.equal(ticket.controller.signal.aborted, false);
});

test("repeated invalidation is safe and new work receives the latest revision", () => {
  const gate = loadRevisionGate()();
  gate.invalidate();
  gate.invalidate();
  const ticket = gate.begin();
  assert.equal(ticket.revision, 2);
  assert.equal(gate.isCurrent(ticket), true);
});
