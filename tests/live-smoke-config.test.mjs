import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("../test-live-smoke.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the paid smoke test requires explicit confirmation and stays outside CI", () => {
  assert.equal(packageJson.scripts["smoke:live"], "node test-live-smoke.mjs");
  assert.match(script, /--confirm-paid/);
  assert.doesNotMatch(workflow, /smoke:live|test-live-smoke/);
  assert.doesNotMatch(packageJson.scripts.test, /test-live-smoke/);
});

test("the paid smoke covers every provider route without printing returned content", () => {
  for (const route of ["/api/transcribe", "/api/label", "/api/generate"]) assert.match(script, new RegExp(route));
  assert.match(script, /privacy\s*\)/);
  assert.match(script, /content not printed/);
  assert.doesNotMatch(script, /JSON\.stringify\((?:transcript|diagram|output)\)/);
});
