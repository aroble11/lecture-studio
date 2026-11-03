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

test("site recordings get a dated label and a Windows-safe file name that matches the recorded format", () => {
  const recording = loadLifecycle();
  const label = recording.recordingLabel(new Date(2026, 10, 3, 14, 5));
  assert.ok(recording.isSiteRecording(label));
  assert.match(label, /^Recording \(.+, .+\)$/);
  assert.equal(recording.isSiteRecording("lecture.m4a"), false);
  assert.equal(recording.isSiteRecording("Sample lecture"), false);

  const name = recording.recordingFileName("Recording (Nov 3, 2:05 PM)", "audio/webm;codecs=opus");
  assert.equal(name, "Lecture recording (Nov 3, 2-05 PM).webm");
  assert.doesNotMatch(name, /[\\/:*?"<>| ]/);
  // Older saves used a time-only label.
  assert.equal(recording.recordingFileName("Recording (2:05 PM)", "audio/webm"), "Lecture recording (2-05 PM).webm");

  assert.equal(recording.recordingExtension("audio/ogg; codecs=opus"), "ogg");
  assert.equal(recording.recordingExtension("audio/mp4"), "m4a");
  assert.equal(recording.recordingExtension("audio/wav"), "wav");
  assert.equal(recording.recordingExtension(""), "webm");
});

test("the capture screen offers Save recording only for recordings made on the site", () => {
  const source = fs.readFileSync("app/components/LectureCapture.tsx", "utf8");
  assert.match(source, /selectAudio\(blob, recordingLabel\(new Date\(startedAt\)\)\)/);
  assert.match(source, /isSiteRecording\(audio\.label\) && \(/);
  assert.match(source, /download=\{recordingFileName\(audio\.label, audio\.blob\.type\)\}/);
});

test("paused time is left out of the recorded time and the 90-minute limit", () => {
  const recording = loadLifecycle();
  let clock = recording.startRecordingClock(1_000);
  assert.equal(recording.recordedMs(clock, 61_000), 60_000);
  clock = recording.pauseRecordingClock(clock, 61_000);
  assert.equal(recording.recordedMs(clock, 10_000_000), 60_000, "a long pause adds nothing");
  assert.equal(recording.pauseRecordingClock(clock, 20_000_000), clock, "pausing twice changes nothing");
  clock = recording.resumeRecordingClock(clock, 10_000_000);
  assert.equal(recording.recordedMs(clock, 10_030_000), 90_000);
  assert.equal(recording.resumeRecordingClock(clock, 10_050_000), clock, "continuing twice changes nothing");

  // An 80-minute pause inside a 95-minute session leaves 15 recorded minutes: no automatic stop.
  let session = recording.startRecordingClock(0);
  session = recording.pauseRecordingClock(session, 10 * 60_000);
  session = recording.resumeRecordingClock(session, 90 * 60_000);
  assert.equal(recording.recordingLimitReason(recording.recordedMs(session, 95 * 60_000), 0), null);

  assert.equal(recording.canPauseRecorder({ pause() {}, resume() {} }), true);
  assert.equal(recording.canPauseRecorder({}), false);
  assert.equal(recording.canPauseRecorder(null), false);
});

test("the capture screen pauses and continues the active recorder and counts only recorded time", () => {
  const source = fs.readFileSync("app/components/LectureCapture.tsx", "utf8");
  assert.match(source, /recorder\.state !== "recording"\) return;\s*try \{ recorder\.pause\(\); \}/);
  assert.match(source, /recorder\.state !== "paused"\) return;\s*try \{ recorder\.resume\(\); \}/);
  assert.match(source, /const nextElapsed = recordedSoFar\(\);/);
  assert.match(source, /recordingLimitReason\(recordedSoFar\(\), recordedBytes\)/);
  assert.match(source, /The microphone is still on, but nothing is being recorded\./);
});
