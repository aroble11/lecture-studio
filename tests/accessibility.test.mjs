import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const capture = readFileSync(new URL("../app/components/LectureCapture.tsx", import.meta.url), "utf8");

test("audio and image upload controls remain keyboard accessible", () => {
  for (const id of ["lecture-audio-upload", "reference-image-upload"]) {
    assert.match(capture, new RegExp(`id="${id}"[\\s\\S]*?className="peer sr-only"`));
    assert.match(capture, new RegExp(`htmlFor="${id}"`));
  }
  assert.doesNotMatch(capture, /<input[^>]+type="file"[^>]+className="hidden"/);
  assert.match(capture, /peer-focus-visible:outline/);
});

test("the reference-image upload is associated with its explanatory text", () => {
  assert.match(capture, /id="reference-image-help"/);
  assert.match(capture, /aria-describedby="reference-image-help"/);
});
