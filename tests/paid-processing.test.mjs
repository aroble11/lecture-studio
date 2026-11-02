import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";

// Load the real route handlers with isolated environment settings and stubbed paid providers.
// No network requests, keys, dev server, or live API credits are needed.
function load(file, env, providers) {
  const unexpected = () => { throw new Error("Paused route contacted a paid provider"); };
  providers = {
    "@/lib/meta-asr": { transcribePcm: unexpected },
    "@/lib/generate": { generateMaterials: unexpected, generatePrivately: unexpected },
    "@/lib/label": { analyzeImage: unexpected },
    "@/lib/usage-budget": { withUsageBudget: async (_operation, work) => work() },
    ...providers,
  };
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  vm.runInNewContext(source, {
    module: compiledModule, exports: compiledModule.exports, process: { env }, Response, URL, Uint8Array, TextDecoder, console,
    require(name) {
      if (name in providers) return providers[name];
      if (name.startsWith("@/")) return load(path.resolve(name.slice(2)) + ".ts", env, providers);
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return compiledModule.exports;
}

const cases = [
  ["transcribe", { "content-type": "application/octet-stream" }, new Uint8Array([0, 0])],
  ["generate", { "content-type": "application/json" }, JSON.stringify({ turns: [{ startMs: 0, endMs: 1000, text: "A lecture." }] })],
  ["label", { "content-type": "application/json" }, JSON.stringify({ image: "data:image/png;base64,AAAA" })],
];

for (const [route, headers, body] of cases) {
  for (const setting of ["false", " FALSE ", "", "typo"]) {
    test(`${route}: ${JSON.stringify(setting)} blocks before body parsing or provider work`, async () => {
      const POST = load(`app/api/${route}/route.ts`, { PAID_PROCESSING_ENABLED: setting }, {}).POST;
      const response = await POST({}); // No request methods: body/header access would throw.
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match((await response.json()).error, /temporarily paused/);
    });
  }

  for (const setting of [undefined, "true"]) {
    test(`${route}: ${setting ?? "unset"} allows normal provider processing`, async () => {
      let calls = 0;
      const provider = async () => { calls++; return { ok: true }; };
      const env = { META_API_KEY: "test-only", BASETEN_API_KEY: "test-only" };
      if (setting !== undefined) env.PAID_PROCESSING_ENABLED = setting;
      const POST = load(`app/api/${route}/route.ts`, env, {
        "@/lib/meta-asr": { transcribePcm: provider },
        "@/lib/generate": { generateMaterials: provider, generatePrivately: provider },
        "@/lib/label": { analyzeImage: provider },
      }).POST;
      const response = await POST(new Request(`http://localhost/api/${route}`, { method: "POST", headers, body }));
      assert.equal(response.status, 200);
      assert.equal(calls, 1);
    });
  }
}

test("the switch also blocks Baseten generation", async () => {
  let calls = 0;
  const POST = load("app/api/generate/route.ts", {
    PAID_PROCESSING_ENABLED: "false", META_API_KEY: "test-only", BASETEN_API_KEY: "test-only",
  }, { "@/lib/generate": { generatePrivately: async () => { calls++; } } }).POST;
  const response = await POST(new Request("http://localhost/api/generate", {
    method: "POST", body: JSON.stringify({ privacy: true, turns: [{ startMs: 0, text: "Lecture" }] }),
  }));
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
});

for (const [route, headers, body] of cases) {
  test(`${route}: budget denial prevents provider work`, async () => {
    let checked = false;
    const POST = load(`app/api/${route}/route.ts`, { META_API_KEY: "test-only" }, {
      "@/lib/usage-budget": { withUsageBudget: async (operation) => {
        assert.equal(operation, route);
        checked = true;
        return Response.json({ error: "Allowance exhausted" }, { status: 429 });
      } },
    }).POST;
    const response = await POST(new Request(`http://localhost/api/${route}`, { method: "POST", headers, body }));
    assert.equal(response.status, 429);
    assert.equal(checked, true);
  });
}

for (const [route, headers, validBody] of cases) {
  const limit = route === "generate" ? 1_000_000 : 4_000_000;
  for (const declared of [undefined, "1"]) {
    test(`${route}: actual body limit enforced with ${declared ? "understated" : "absent"} Content-Length`, async () => {
      let budgetCalls = 0;
      const POST = load(`app/api/${route}/route.ts`, { META_API_KEY: "test-only" }, {
        "@/lib/usage-budget": { withUsageBudget: async () => { budgetCalls++; assert.fail("Must not reserve quota"); } },
      }).POST;
      const requestHeaders = { ...headers };
      if (declared) requestHeaders["content-length"] = declared;
      const body = route === "transcribe" ? new Uint8Array(limit + 2) : validBody + " ".repeat(limit);
      const response = await POST(new Request(`http://localhost/api/${route}`, { method: "POST", headers: requestHeaders, body }));
      assert.equal(response.status, 413);
      assert.equal(budgetCalls, 0);
    });
  }

  test(`${route}: a valid request exactly at the byte cap is accepted`, async () => {
    let paidCalls = 0;
    const provider = async () => { paidCalls++; return { ok: true }; };
    const POST = load(`app/api/${route}/route.ts`, { META_API_KEY: "test-only" }, {
      "@/lib/meta-asr": { transcribePcm: provider },
      "@/lib/generate": { generateMaterials: provider },
      "@/lib/label": { analyzeImage: provider },
    }).POST;
    const body = route === "transcribe" ? new Uint8Array(limit) : validBody + " ".repeat(limit - Buffer.byteLength(validBody));
    const response = await POST(new Request(`http://localhost/api/${route}`, { method: "POST", headers, body }));
    assert.equal(response.status, 200);
    assert.equal(paidCalls, 1);
  });
}

test("oversized stream is cancelled at the first excessive chunk without draining", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const { readBoundedBytes } = load("lib/request-body.ts", {}, {});
  const result = await readBoundedBytes({ headers: new Headers(), body }, 4);
  assert.equal(result.response.status, 413);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("oversized declared length cancels without reading", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull() { pulls++; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const { readBoundedBytes } = load("lib/request-body.ts", {}, {});
  const result = await readBoundedBytes({ headers: new Headers({ "content-length": "5" }), body }, 4);
  assert.equal(result.response.status, 413);
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
});

for (const header of ["-1", "NaN", "1.5", "1, 2"]) {
  test(`invalid Content-Length ${header} is rejected`, async () => {
    const { readBoundedBytes } = load("lib/request-body.ts", {}, {});
    const result = await readBoundedBytes(new Request("http://localhost", {
      method: "POST", headers: { "content-length": header }, body: "x",
    }), 4);
    assert.equal(result.response.status, 400);
  });
}

test("UTF-8 bytes are counted rather than characters", async () => {
  const { readBoundedJson } = load("lib/request-body.ts", {}, {});
  const body = JSON.stringify({ text: "é" });
  const result = await readBoundedJson(new Request("http://localhost", { method: "POST", body }), body.length);
  assert.equal(result.response.status, 413);
});

test("split UTF-8 characters decode correctly after bounded reading", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ text: "é" }));
  let i = 0;
  const body = new ReadableStream({ pull(c) {
    if (i === bytes.length) c.close();
    else c.enqueue(bytes.slice(i, ++i));
  } });
  const { readBoundedJson } = load("lib/request-body.ts", {}, {});
  const result = await readBoundedJson({ headers: new Headers(), body }, bytes.length);
  assert.equal(result.ok, true);
  assert.equal(result.value.text, "é");
});

for (const body of ["{", "", new Uint8Array([255])]) {
  test(`invalid or empty JSON is rejected (${typeof body})`, async () => {
    const { readBoundedJson } = load("lib/request-body.ts", {}, {});
    const result = await readBoundedJson(new Request("http://localhost", { method: "POST", body }), 10);
    assert.equal(result.response.status, 400);
  });
}

test("interrupted streams return a controlled error and release the lock", async () => {
  const body = new ReadableStream({ pull(c) { c.error(new Error("connection interrupted")); } });
  const { readBoundedBytes } = load("lib/request-body.ts", {}, {});
  const result = await readBoundedBytes({ headers: new Headers(), body }, 4);
  assert.equal(result.response.status, 400);
  assert.equal(body.locked, false);
});

test("compressed requests are rejected before parsing", async () => {
  const { readBoundedBytes } = load("lib/request-body.ts", {}, {});
  const result = await readBoundedBytes(new Request("http://localhost", {
    method: "POST", headers: { "content-encoding": "gzip" }, body: "x",
  }), 4);
  assert.equal(result.response.status, 415);
});
