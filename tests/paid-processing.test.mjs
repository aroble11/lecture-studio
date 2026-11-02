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
    module: compiledModule, exports: compiledModule.exports, process: { env }, Response, URL, Uint8Array, console,
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
