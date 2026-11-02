import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

test("the unified offline test command cannot discover paid root scripts", () => {
  assert.equal(packageJson.scripts.test, 'node --test "tests/*.test.mjs"');
  assert.doesNotMatch(packageJson.scripts.test, /test-(?:api|baseten|generate|label|route|sam|transcribe)\.mjs/);
});

test("type-checking generates Next.js route helpers in a clean checkout", () => {
  assert.equal(packageJson.scripts.typecheck, "next typegen && tsc --noEmit");
});

test("production dependency advisories fail locally and in CI", () => {
  assert.equal(packageJson.scripts["audit:prod"], "npm audit --omit=dev --audit-level=moderate");
  assert.match(workflow, /npm\s+run\s+audit:prod/);
});

test("CI runs every local quality gate and needs no provider secrets", () => {
  for (const command of ["npm ci", "npm run audit:prod", "npm run lint", "npm run typecheck", "npm test", "npm run build"]) {
    assert.match(workflow, new RegExp(command.replaceAll(" ", "\\s+")));
  }
  assert.doesNotMatch(workflow, /secrets\.|META_API_KEY|BASETEN_API_KEY|LIMITS_KV_/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /persist-credentials: false/);
});

test("third-party actions are pinned to complete commit SHAs", () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
  assert.equal(uses.length, 2);
  for (const action of uses) assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
});
