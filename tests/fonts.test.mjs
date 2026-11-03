import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("production fonts are bundled, never fetched from Google Fonts", () => {
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.match(layout, /next\/font\/local/);
  assert.match(layout, /\.\/fonts\/nunito-latin-wght-normal\.woff2/);
  assert.ok(existsSync(new URL("../app/fonts/nunito-latin-wght-normal.woff2", import.meta.url)), "bundled Nunito file is missing");
  assert.ok(existsSync(new URL("../app/fonts/Nunito-OFL.txt", import.meta.url)), "Nunito license must ship with the font");
  assert.match(layout, /geist\/font\/mono/);
  assert.match(layout, /GeistMono\.variable/);
  assert.ok(packageJson.dependencies.geist, "geist must stay a production dependency");
});

test("the bundled sans and mono variables are applied", () => {
  assert.match(css, /--font-sans:\s*var\(--font-nunito\)/);
  assert.match(css, /--font-mono:\s*var\(--font-geist-mono\)/);
  assert.match(css, /font-family:\s*var\(--font-nunito\)/);
});
