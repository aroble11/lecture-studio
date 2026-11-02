import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("production fonts come from the bundled Geist package", () => {
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.match(layout, /geist\/font\/sans/);
  assert.match(layout, /geist\/font\/mono/);
  assert.match(layout, /GeistSans\.variable/);
  assert.match(layout, /GeistMono\.variable/);
  assert.equal(packageJson.dependencies.geist, "^1.7.0");
});

test("the bundled sans and mono variables are applied", () => {
  assert.match(css, /--font-sans:\s*var\(--font-geist-sans\)/);
  assert.match(css, /--font-mono:\s*var\(--font-geist-mono\)/);
  assert.match(css, /font-family:\s*var\(--font-geist-sans\)/);
});
