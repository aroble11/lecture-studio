import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("the capture screen names every external processing destination before upload", () => {
  const source = fs.readFileSync("app/components/LectureCapture.tsx", "utf8");
  assert.match(source, /Audio chunks and key vocabulary go to Meta for transcription/);
  assert.match(source, /reference image plus subject, grade, objective, and vocabulary go to Meta for labeling/);
  assert.match(source, /open-weight option sends that generation step to Baseten instead/);
  assert.match(source, /Use open-weight model for materials/);
  assert.doesNotMatch(source, />Privacy Mode</);
});

test("the privacy page explains local deletion and avoids unverified provider claims", () => {
  const source = fs.readFileSync("app/privacy/page.tsx", "utf8");
  assert.match(source, /Start over/);
  assert.match(source, /Delete profile/);
  assert.match(source, /does not make claims about provider retention, district approval, or legal compliance/);
  assert.match(source, /Audio over 100 MB/);
});

test("open-weight results use a narrow generation badge", () => {
  const source = fs.readFileSync("app/components/MaterialsView.tsx", "utf8");
  assert.match(source, /Open-weight generation/);
  assert.doesNotMatch(source, /Privacy Mode/);
});
