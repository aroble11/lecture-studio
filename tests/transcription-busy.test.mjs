import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function compile(file) {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function run(source, globals, require) {
  const compiled = { exports: {} };
  vm.runInNewContext(source, {
    module: compiled, exports: compiled.exports, AbortController, DOMException, Response,
    setTimeout, clearTimeout, require, ...globals,
  });
  return compiled.exports;
}

const realConfig = run(compile("lib/config.ts"), {}, () => { throw new Error("unexpected dependency"); });
// Real limits, but millisecond waits so tests stay fast and deterministic.
const ASR = {
  ...realConfig.ASR, busyRetryMinMs: 1, busyRetryMaxMs: 5, busyRetryDefaultMs: 3, busyRetryJitterMs: 0,
  busyGiveUpMs: 30_000, busyRecoverMs: 0, busyIdleCheckMs: 1,
};
const audioSource = compile("lib/audio-client.ts");

function client(fetch, overrides = {}) {
  return run(audioSource, { fetch }, (name) => {
    if (name === "./config") return { ASR: { ...ASR, ...overrides } };
    throw new Error(`Unexpected dependency: ${name}`);
  });
}

// Values created inside the vm sandbox have that realm's prototypes; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ok = (text) => Response.json({ turns: [{ startMs: 0, endMs: 1000, text }] });
const busy = (retryAfter = "1") => Response.json(
  { reason: "busy", error: "The service is busy." }, { status: 429, headers: { "Retry-After": retryAfter } });
// Silence plans into equal minimum-length chunks; tests read the plan rather than assume a count.
const lecture = (sampleRate) => new Float32Array(sampleRate * 120);
const plan = ({ planChunks, SAMPLE_RATE }) => planChunks(lecture(SAMPLE_RATE));

test("a busy response waits and retries instead of failing the lecture", async () => {
  let calls = 0;
  const audio = client(async () => (++calls === 1 ? busy() : ok(`part ${calls}`)));
  const chunks = plan(audio).length;
  assert.ok(chunks >= 2);
  const progress = [];
  const turns = await audio.transcribeLecture(lecture(audio.SAMPLE_RATE), [], { concurrency: 2, onProgress: (p) => progress.push(p) });
  assert.equal(turns.length, chunks);
  assert.equal(calls, chunks + 1);
  assert.equal(progress.some((p) => p.waiting === true), true);
  assert.deepEqual(plain(progress.at(-1)), { done: chunks, total: chunks, waiting: false });
});

test("a pause ends as soon as a sibling chunk finishes and frees a slot", async () => {
  let calls = 0;
  const audio = client(async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => setTimeout(() => resolve(ok("first")), 50));
    return calls === 2 ? busy("10") : ok("next");
  }, { busyRetryMinMs: 10_000, busyRetryMaxMs: 10_000, busyRetryDefaultMs: 10_000 });
  const chunks = plan(audio).length;
  const started = Date.now();
  const turns = await audio.transcribeLecture(lecture(audio.SAMPLE_RATE), [], { concurrency: 2 });
  assert.equal(turns.length, chunks);
  assert.equal(calls, chunks + 1);
  assert.ok(Date.now() - started < 5_000, "should not wait out the full 10-second pause");
});

test("a firewall 429 without a reason is also waited out", async () => {
  let calls = 0;
  const audio = client(async () =>
    (++calls === 1 ? new Response("Too Many Requests", { status: 429 }) : ok("text")));
  const chunks = plan(audio).length;
  const turns = await audio.transcribeLecture(lecture(audio.SAMPLE_RATE), [], { concurrency: 1 });
  assert.equal(turns.length, chunks);
  assert.equal(calls, chunks + 1);
});

test("a daily-allowance 429 is final and is not retried", async () => {
  let calls = 0;
  const { transcribeLecture, SAMPLE_RATE } = client(async () => {
    calls++;
    return Response.json({ reason: "daily", error: "Daily allowance reached." }, { status: 429, headers: { "Retry-After": "3600" } });
  });
  await assert.rejects(() => transcribeLecture(lecture(SAMPLE_RATE), [], { concurrency: 1 }), /Daily allowance reached/);
  assert.equal(calls, 1);
});

test("a service that stays busy gives up with a clear message and keeps finished chunks", async () => {
  let calls = 0;
  const audio = client(async () => (++calls === 1 ? ok("first") : busy()), { busyGiveUpMs: 300 });
  const error = await audio.transcribeLecture(lecture(audio.SAMPLE_RATE), [], { concurrency: 1 }).then(
    () => assert.fail("expected failure"), (err) => err);
  assert.match(error.message, /still busy/);
  assert.equal(error.name, "TranscriptionError");
  assert.equal(error.partial.length, plan(audio).length);
  assert.equal(error.partial[0][0].text, "First");
  assert.equal(error.partial[1], undefined);
});

test("a retry resends only the chunks that did not finish", async () => {
  let calls = 0;
  const first = client(async () => (++calls === 2 ? Response.json({ error: "bad chunk" }, { status: 400 }) : ok(`run one ${calls}`)));
  const error = await first.transcribeLecture(lecture(first.SAMPLE_RATE), [], { concurrency: 1 }).then(
    () => assert.fail("expected failure"), (err) => err);
  assert.match(error.message, /bad chunk/);
  assert.equal(error.partial.filter(Boolean).length, 1);
  const chunks = error.partial.length;

  const sent = [];
  const second = client(async () => { sent.push(1); return ok("run two"); });
  const progress = [];
  const turns = await second.transcribeLecture(lecture(second.SAMPLE_RATE), [], {
    concurrency: 2, resume: error.partial, onProgress: (p) => progress.push(p),
  });
  assert.equal(sent.length, chunks - 1);
  assert.deepEqual(plain(turns.map((t) => t.text)), ["Run one 1", ...Array(chunks - 1).fill("Run two")]);
  const starts = plan(second).map((c) => Math.round((c.start / second.SAMPLE_RATE) * 1000));
  assert.deepEqual(plain(turns.map((t) => t.startMs)), plain(starts));
  assert.deepEqual(plain(progress[0]), { done: 1, total: chunks, waiting: false });
});

test("saved chunks from a different chunk plan are ignored", async () => {
  let calls = 0;
  const audio = client(async () => { calls++; return ok("fresh"); });
  const turns = await audio.transcribeLecture(lecture(audio.SAMPLE_RATE), [], { concurrency: 1, resume: [[{ startMs: 0, endMs: 1, text: "stale" }]] });
  assert.equal(calls, plan(audio).length);
  assert.equal(turns.some((t) => t.text === "stale"), false);
});

test("cancelling while workers wait out a busy response stops without more requests", async () => {
  let calls = 0;
  const controller = new AbortController();
  const { transcribeLecture, SAMPLE_RATE } = client(async () => {
    calls++;
    queueMicrotask(() => controller.abort(new DOMException("Cancelled", "AbortError")));
    return busy("1");
  });
  await assert.rejects(() => transcribeLecture(lecture(SAMPLE_RATE), [], { concurrency: 1, signal: controller.signal }), /Cancelled/);
  assert.equal(calls, 1);
});
