import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

function loadAudio(globals = {}) {
  const file = path.resolve("lib/audio-client.ts");
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(source, {
    module: compiled, exports: compiled.exports, console, AbortController, DOMException,
    setTimeout, clearTimeout, ...globals,
    require(name) {
      if (name === "./config") return { ASR: { sampleRate: 24_000, concurrency: 6, clientChunkTimeoutMs: 100_000 } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return compiled.exports;
}

test("audio is mixed and resampled to the ASR rate when a browser uses another rate", () => {
  const { toMonoAtRate } = loadAudio();
  const left = Float32Array.from([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25]);
  const right = Float32Array.from([0, -0.25, -0.5, -0.75, -1, -0.75, -0.5, -0.25]);
  assert.deepEqual([...toMonoAtRate([left], 8, 4)], [0, 0.5, 1, 0.5]);
  assert.deepEqual([...toMonoAtRate([left, right], 8, 4)], [0, 0, 0, 0]);
});

test("a simulated 90-minute lecture produces contiguous bounded chunks", () => {
  const { planChunks } = loadAudio();
  const virtualRate = 10;
  const samples = new Float32Array(90 * 60 * virtualRate);
  const chunks = planChunks(samples, virtualRate);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, samples.length);
  assert.ok(chunks.length > 70);
  chunks.forEach((chunk, i) => {
    assert.ok(chunk.end > chunk.start);
    assert.ok(chunk.end - chunk.start <= 75 * virtualRate);
    if (i) assert.equal(chunk.start, chunks[i - 1].end);
  });
});

test("metadata duration preflight cleans up its temporary media URL", async () => {
  let revoked = null;
  const audio = {
    duration: 5_401,
    preload: "",
    src: "",
    removeAttribute() { this.src = ""; },
    load() { if (this.src) queueMicrotask(() => this.onloadedmetadata()); },
  };
  const { readAudioDurationMs } = loadAudio({
    document: { createElement: () => audio },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: (url) => { revoked = url; } },
    queueMicrotask,
  });
  assert.equal(await readAudioDurationMs({}), 5_401_000);
  assert.equal(audio.preload, "metadata");
  assert.equal(revoked, "blob:test");
  assert.equal(audio.src, "");
});
