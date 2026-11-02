import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function loadTs(file, globals = {}, providers = {}, cache = new Map()) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  cache.set(file, compiled);
  vm.runInNewContext(source, {
    module: compiled, exports: compiled.exports, console, AbortController, DOMException,
    setTimeout, clearTimeout, Response, ...globals,
    require(name) {
      if (name in providers) return providers[name];
      if (name.startsWith("./") || name.startsWith("../")) {
        const resolved = path.resolve(path.dirname(file), name);
        return loadTs(path.extname(resolved) ? resolved : `${resolved}.ts`, globals, providers, cache);
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return compiled.exports;
}

function labelHarness(responses) {
  const calls = { clients: [], requests: [], options: [] };
  class OpenAI {
    constructor(options) {
      calls.clients.push(options);
      this.responses = { create: async (request, options) => {
        calls.requests.push(request);
        calls.options.push(options);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      } };
    }
  }
  const label = loadTs("lib/label.ts", {}, { openai: { default: OpenAI } });
  return { ...label, calls };
}

const plan = (objects = []) => ({
  status: "completed",
  output_text: JSON.stringify({ kind: "objects", summary: "A diagram.", objects }),
});

test("label planning disables SDK retries and preserves room for fallback", async () => {
  const signal = new AbortController().signal;
  const { analyzeImage, calls } = labelHarness([new Error("primary failed"), plan()]);
  const result = await analyzeImage("data:image/png;base64,test", {}, { apiKey: "test", signal });
  assert.equal(result.items.length, 0);
  assert.equal(calls.clients[0].maxRetries, 0);
  assert.equal(calls.clients[0].timeout, 18_000);
  assert.equal(calls.options.length, 2);
  assert.deepEqual(calls.options.map((o) => o.timeout), [18_000, 18_000]);
  assert.equal(calls.options.every((o) => o.signal === signal), true);
});

test("an aborted label request does not spend its planning fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  const { analyzeImage, calls } = labelHarness([new Error("cancelled"), plan()]);
  await assert.rejects(() => analyzeImage("data:image/png;base64,test", {}, {
    apiKey: "test", signal: controller.signal,
  }), /cancelled/);
  assert.equal(calls.requests.length, 1);
});

test("parallel segmentation calls use their smaller timeout and request signal", async () => {
  const signal = new AbortController().signal;
  const object = { phrase: "heart", label: "Heart", approxBox: { x1: 10, y1: 10, x2: 500, y2: 500 } };
  const sam = { status: "completed", output_text: "<|box;x1=10;y1=10;x2=50;y2=50;w=100;h=100;c=0.9|>" };
  const { analyzeImage, calls } = labelHarness([plan([object]), sam]);
  const result = await analyzeImage("data:image/png;base64,test", {}, { apiKey: "test", signal });
  assert.equal(result.items.length, 1);
  assert.equal(calls.options[0].timeout, 18_000);
  assert.equal(calls.options[1].timeout, 15_000);
  assert.equal(calls.options[1].signal, signal);
});

test("one failed transcription chunk aborts its in-flight siblings", async () => {
  let calls = 0;
  let siblingAborted = false;
  const fakeFetch = (_url, options) => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(Response.json({ error: "first chunk rejected" }, { status: 400 }));
    }
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        siblingAborted = true;
        reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  };
  const { transcribeLecture, SAMPLE_RATE } = loadTs("lib/audio-client.ts", { fetch: fakeFetch });
  const samples = new Float32Array(SAMPLE_RATE * 120);
  await assert.rejects(() => transcribeLecture(samples, [], { concurrency: 2 }), /first chunk rejected/);
  assert.equal(calls, 2);
  assert.equal(siblingAborted, true);
});

test("an already-cancelled ASR request never opens a provider socket", async () => {
  let sockets = 0;
  class WebSocketStub { constructor() { sockets++; } }
  const controller = new AbortController();
  controller.abort();
  const { transcribePcm } = loadTs("lib/meta-asr.ts", { WebSocket: WebSocketStub }, {
    "./config": { ASR: { sampleRate: 24_000, speed: 2, packetMs: 80 }, META_ASR_URL: "wss://test", MODELS: { transcribe: "test" } },
  });
  await assert.rejects(() => transcribePcm(new Uint8Array([0, 0]), { apiKey: "test", signal: controller.signal }), /cancelled/);
  assert.equal(sockets, 0);
});

test("cancelling an active ASR request closes its provider socket", async () => {
  let closed = false;
  class WebSocketStub {
    constructor() { this.binaryType = ""; }
    close() { closed = true; }
  }
  const controller = new AbortController();
  const { transcribePcm } = loadTs("lib/meta-asr.ts", { WebSocket: WebSocketStub }, {
    "./config": { ASR: { sampleRate: 24_000, speed: 2, packetMs: 80 }, META_ASR_URL: "wss://test", MODELS: { transcribe: "test" } },
  });
  const pending = transcribePcm(new Uint8Array([0, 0]), { apiKey: "test", signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, /cancelled/);
  assert.equal(closed, true);
});
