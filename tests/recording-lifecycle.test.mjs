import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function loadLifecycle() {
  const source = ts.transpileModule(fs.readFileSync("lib/recording-lifecycle.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, { module: compiled, exports: compiled.exports });
  return compiled.exports;
}

test("recordings stop at the exact duration and byte boundaries", () => {
  const recording = loadLifecycle();
  const stopAt = recording.RECORDING_LIMITS.durationMs - recording.RECORDING_LIMITS.stopLeadMs;
  assert.equal(recording.recordingLimitReason(stopAt - 1, 0), null);
  assert.equal(recording.recordingLimitReason(stopAt, 0), "duration");
  assert.equal(recording.recordingLimitReason(0, recording.RECORDING_LIMITS.bytes - 1), null);
  assert.equal(recording.recordingLimitReason(0, recording.RECORDING_LIMITS.bytes), "size");
});

test("cleanup stops every media track and only an active recorder", () => {
  const recording = loadLifecycle();
  let trackStops = 0;
  recording.stopMediaStream({ getTracks: () => [{ stop: () => trackStops++ }, { stop: () => trackStops++ }] });
  assert.equal(trackStops, 2);

  let recorderStops = 0;
  recording.stopMediaRecorder({ state: "recording", stop: () => recorderStops++ });
  recording.stopMediaRecorder({ state: "inactive", stop: () => recorderStops++ });
  assert.equal(recorderStops, 1);
});

test("recording falls back when a browser rejects the bitrate option", () => {
  const recording = loadLifecycle();
  const calls = [];
  const recorder = recording.createCompatibleMediaRecorder({}, (options) => {
    calls.push(options);
    if (options) throw new Error("unsupported option");
    return { state: "inactive" };
  });
  assert.equal(recorder.state, "inactive");
  assert.equal(calls[0].audioBitsPerSecond, 128_000);
  assert.equal(calls[1], undefined);
});

test("capture UI exposes permission state and unmount cleanup", () => {
  const source = fs.readFileSync("app/components/LectureCapture.tsx", "utf8");
  assert.match(source, /kind: "requesting-microphone"/);
  assert.match(source, /Waiting for microphone permission/);
  assert.match(source, /return \(\) => \{[\s\S]*stopMediaRecorder\(recorderRef\.current\)[\s\S]*stopMediaStream\(streamRef\.current\)/);
  assert.match(source, /recordingLimitReason\(nextElapsed, recordedBytes\)/);
});
