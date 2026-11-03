import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import sharp from "sharp";

// Load the real route handlers with isolated environment settings and stubbed paid providers.
// No network requests, keys, dev server, or live API credits are needed.
function load(file, env, providers, cache = new Map()) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
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
  cache.set(file, compiledModule.exports);
  vm.runInNewContext(source, {
    module: compiledModule, exports: compiledModule.exports, process: { env }, Response, URL, Uint8Array, TextDecoder, Buffer, console,
    require(name) {
      if (name in providers) return providers[name];
      if (name === "sharp") return { default: sharp };
      if (name.startsWith("@/")) return load(path.resolve(name.slice(2)) + ".ts", env, providers, cache);
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return compiledModule.exports;
}

const fixtureImage = "data:image/png;base64," + (await sharp({ create: {
  width: 1, height: 1, channels: 3, background: "white",
} }).png().toBuffer()).toString("base64");
const cases = [
  ["transcribe", { "content-type": "application/octet-stream" }, new Uint8Array([0, 0])],
  ["generate", { "content-type": "application/json" }, JSON.stringify({ turns: [{ startMs: 0, endMs: 1000, text: "A lecture." }] })],
  ["label", { "content-type": "application/json" }, JSON.stringify({ image: fixtureImage })],
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

test("open-weight generation works with a Baseten key and no Meta key", async () => {
  let privateCalls = 0;
  let standardCalls = 0;
  const POST = load("app/api/generate/route.ts", { BASETEN_API_KEY: "baseten-only" }, {
    "@/lib/generate": {
      generatePrivately: async (_turns, _context, opts) => {
        privateCalls++;
        assert.equal(opts.apiKey, "baseten-only");
        return { ok: true };
      },
      generateMaterials: async () => { standardCalls++; return { ok: true }; },
    },
  }).POST;
  const response = await POST(new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ privacy: true, turns: [{ startMs: 0, endMs: 1000, text: "Lecture" }] }),
  }));
  assert.equal(response.status, 200);
  assert.equal(privateCalls, 1);
  assert.equal(standardCalls, 0);
});

test("each generation mode checks only its selected provider credential", async () => {
  let calls = 0;
  const providers = {
    "@/lib/generate": {
      generatePrivately: async () => { calls++; },
      generateMaterials: async () => { calls++; },
    },
  };
  const body = (privacy) => JSON.stringify({ privacy, turns: [{ startMs: 0, endMs: 1000, text: "Lecture" }] });
  const standard = load("app/api/generate/route.ts", { BASETEN_API_KEY: "test-only" }, providers).POST;
  const standardResponse = await standard(new Request("http://localhost/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: body(false),
  }));
  assert.equal(standardResponse.status, 500);
  assert.match((await standardResponse.json()).error, /META_API_KEY/);

  const openWeight = load("app/api/generate/route.ts", { META_API_KEY: "test-only" }, providers).POST;
  const openWeightResponse = await openWeight(new Request("http://localhost/api/generate", {
    method: "POST", headers: { "content-type": "application/json" }, body: body(true),
  }));
  assert.equal(openWeightResponse.status, 503);
  assert.match((await openWeightResponse.json()).error, /Open-weight generation/);
  assert.equal(calls, 0);
});

for (const [route, headers, body] of cases) {
  test(`${route}: budget denial prevents provider work`, async () => {
    let checked = false;
    const POST = load(`app/api/${route}/route.ts`, { META_API_KEY: "test-only" }, {
      "@/lib/usage-budget": { withUsageBudget: async (operation, _work, request) => {
        assert.equal(operation, route);
        assert.equal(request instanceof Request, true, "route must pass the request for per-visitor limits");
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

const lecture = () => ({ turns: [{ startMs: 0, endMs: 1000, text: "A lecture." }] });
const invalidGeneration = [
  ["null body", null], ["array body", []], ["primitive body", "lecture"], ["missing turns", {}],
  ["empty turns", { turns: [] }], ["null turn", { turns: [null] }],
  ["missing end time", { turns: [{ startMs: 0, text: "Lecture" }] }],
  ["negative time", { turns: [{ startMs: -1, endMs: 1, text: "Lecture" }] }],
  ["backwards time", { turns: [{ startMs: 2, endMs: 1, text: "Lecture" }] }],
  ["long duration", { turns: [{ startMs: 0, endMs: 5_400_001, text: "Lecture" }] }],
  ["unordered turns", { turns: [{ startMs: 2, endMs: 3, text: "Later" }, { startMs: 0, endMs: 1, text: "Earlier" }] }],
  ["string time", { turns: [{ startMs: "0", endMs: 1, text: "Lecture" }] }],
  ["blank text", { turns: [{ startMs: 0, endMs: 1, text: " " }] }],
  ["long turn", { turns: [{ startMs: 0, endMs: 1, text: "a".repeat(12_001) }] }],
  ["too many turns", { turns: Array.from({ length: 10_001 }, () => ({ startMs: 0, endMs: 1, text: "a" })) }],
  ["long transcript", { turns: Array.from({ length: 11 }, () => ({ startMs: 0, endMs: 1, text: "a".repeat(12_000) })) }],
  ["privacy string", { ...lecture(), privacy: "true" }],
  ["null context", { ...lecture(), context: null }],
  ["array context", { ...lecture(), context: [] }],
  ["wrong subject type", { ...lecture(), context: { subject: 1 } }],
  ["long objective", { ...lecture(), context: { objective: "a".repeat(501) } }],
  ["wrong vocabulary type", { ...lecture(), context: { vocabulary: "term" } }],
  ["bad vocabulary item", { ...lecture(), context: { vocabulary: [null] } }],
  ["blank vocabulary item", { ...lecture(), context: { vocabulary: [" "] } }],
  ["long vocabulary item", { ...lecture(), context: { vocabulary: ["a".repeat(81)] } }],
  ["too many vocabulary items", { ...lecture(), context: { vocabulary: Array(51).fill("term") } }],
  ["null diagram", { ...lecture(), diagram: null }],
  ["empty diagram", { ...lecture(), diagram: { items: [] } }],
  ["null diagram item", { ...lecture(), diagram: { items: [null] } }],
  ["invalid diagram number", { ...lecture(), diagram: { items: [{ n: 0, label: "heart" }] } }],
  ["duplicate diagram number", { ...lecture(), diagram: { items: [{ n: 1, label: "heart" }, { n: 1, label: "lung" }] } }],
  ["blank diagram label", { ...lecture(), diagram: { items: [{ n: 1, label: " " }] } }],
];

async function rejectedInput(route, body, expected = 400, contentType = "application/json", query = "") {
  let budgetCalls = 0;
  const POST = load(`app/api/${route}/route.ts`, { META_API_KEY: "test-only" }, {
    "@/lib/usage-budget": { withUsageBudget: async () => { budgetCalls++; assert.fail("Invalid input must not use quota"); } },
  }).POST;
  const response = await POST(new Request(`http://localhost/api/${route}${query}`, {
    method: "POST", headers: { "content-type": contentType },
    body: route === "transcribe" ? body : JSON.stringify(body),
  }));
  assert.equal(response.status, expected);
  assert.equal(typeof (await response.json()).error, "string");
  assert.equal(budgetCalls, 0);
}
for (const [name, input] of invalidGeneration) {
  test(`generation rejects ${name} before quota`, () => rejectedInput("generate", input));
}
for (const input of [null, [], "image", {}, { image: null }, { image: "https://example.com/image.png" },
  { image: "data:image/png;base64,AAAA" }, { image: fixtureImage.replace("image/png", "image/jpeg") },
  { image: fixtureImage + "=" }, { image: fixtureImage, context: { vocabulary: [1] } }]) {
  test(`labeling rejects malformed input ${JSON.stringify(input).slice(0, 60)}`, () => rejectedInput("label", input));
}
for (const [route, , body] of cases) {
  test(`${route} rejects wrong media type`, () => rejectedInput(route, route === "transcribe" ? body : {}, 415, "application/octet-stream-extra"));
}
for (const query of ["?kw=", "?kw=" + "a".repeat(81), "?" + Array(51).fill("kw=term").join("&")]) {
  test(`transcription rejects invalid keywords ${query.slice(0, 40)}`, () => rejectedInput("transcribe", new Uint8Array([0, 0]), 400, "application/octet-stream", query));
}
for (const body of [new Uint8Array(0), new Uint8Array(1)]) {
  test(`transcription rejects ${body.length} audio bytes`, () => rejectedInput("transcribe", body, 400, "application/octet-stream"));
}

test("non-finite timestamps are rejected without numeric coercion", () => {
  const { validateGeneration } = load("lib/input-validation.ts", {}, {});
  for (const startMs of [NaN, Infinity, -Infinity]) {
    assert.throws(() => validateGeneration({ turns: [{ startMs, endMs: 1, text: "Lecture" }] }), /finite/);
  }
});

test("valid context, timing boundary and diagram are normalized without forwarding extra fields", async () => {
  let actual;
  const POST = load("app/api/generate/route.ts", { META_API_KEY: "test-only" }, {
    "@/lib/generate": { generateMaterials: async (...args) => { actual = args; return { ok: true }; } },
  }).POST;
  const response = await POST(new Request("http://localhost/api/generate", {
    method: "POST", headers: { "content-type": "Application/JSON; charset=utf-8" }, body: JSON.stringify({
      turns: [{ startMs: 0, endMs: 5_400_000, text: " Lecture " }], context: {
        subject: " Biology ", grade: "10", objective: "Explain", standards: "Standard", style: "Plain",
        classNotes: "General", vocabulary: [" heart ", "heart"], ignored: "untrusted",
      }, diagram: { summary: " Diagram ", items: [{ n: 1, label: " heart " }] }, privacy: false,
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(actual[0][0].text, "Lecture");
  assert.equal(actual[1].subject, "Biology");
  assert.equal(actual[1].vocabulary.length, 1);
  assert.equal(actual[1].ignored, undefined);
  assert.equal(actual[2].diagram.items[0].label, "heart");
});

for (const format of ["jpeg", "png", "webp"]) {
  test(`a real ${format} image decodes and reaches the provider`, async () => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).toFormat(format).toBuffer();
    let called = false;
    const POST = load("app/api/label/route.ts", { META_API_KEY: "test-only" }, {
      "@/lib/label": { analyzeImage: async () => { called = true; return { ok: true }; } },
    }).POST;
    const response = await POST(new Request("http://localhost/api/label", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: `data:image/${format};base64,${bytes.toString("base64")}` }),
    }));
    assert.equal(response.status, 200);
    assert.equal(called, true);
  });
}

test("an image with a valid header but broken pixels is rejected", async () => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).jpeg().toBuffer();
  const damaged = bytes.subarray(0, bytes.length - 30);
  await rejectedInput("label", { image: "data:image/jpeg;base64," + damaged.toString("base64") });
});

test("an image wider than the prepared-image limit is rejected", async () => {
  const bytes = await sharp({ create: { width: 1601, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await rejectedInput("label", { image: "data:image/png;base64," + bytes.toString("base64") });
});
