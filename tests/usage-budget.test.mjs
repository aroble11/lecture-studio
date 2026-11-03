import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto, { randomUUID } from "node:crypto";
import { test } from "node:test";
import ts from "typescript";

const source = ts.transpileModule(fs.readFileSync("lib/usage-budget.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load(fetch, env = {}) {
  const compiledModule = { exports: {} };
  vm.runInNewContext(source, {
    module: compiledModule, exports: compiledModule.exports,
    process: { env: { LIMITS_KV_REST_API_URL: "https://example.upstash.io", LIMITS_KV_REST_API_TOKEN: "test-only", ...env } },
    require: () => crypto, fetch, Response, URL, AbortSignal,
    console: { warn() {} },
  });
  return compiledModule.exports;
}
const reply = (result) => Response.json({ result });

for (const [reason, retry] of [["daily", 86400], ["visitor", 3600], ["busy", 100]]) {
  test(`${reason} denial never starts paid work and returns Retry-After`, async () => {
    let calls = 0;
    const { withUsageBudget } = load(async () => reply([0, reason, retry]));
    const response = await withUsageBudget("generate", async () => { calls++; });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), String(retry));
    assert.equal((await response.json()).reason, reason);
    assert.equal(calls, 0);
  });
}

for (const [name, fetch] of [
  ["network failure", async () => { throw new Error("secret error"); }],
  ["HTTP failure", async () => new Response("bad", { status: 500 })],
  ["Redis error", async () => Response.json({ error: "bad" })],
  ["malformed admission", async () => reply([1, "unexpected", 0])],
  ["missing result", async () => Response.json({})],
]) {
  test(`${name} fails closed`, async () => {
    const { withUsageBudget } = load(fetch);
    const response = await withUsageBudget("label", async () => assert.fail("Provider must not run"));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /secret/);
  });
}

test("missing configuration fails closed without fetching", async () => {
  const { withUsageBudget } = load(() => assert.fail("No fetch expected"), { LIMITS_KV_REST_API_TOKEN: undefined });
  assert.equal((await withUsageBudget("generate", async () => assert.fail())).status, 503);
});

for (const failure of [false, true]) {
  test(`own lease is released when work ${failure ? "throws" : "succeeds"}`, async () => {
    const commands = [];
    const { withUsageBudget } = load(async (_url, options) => {
      commands.push(JSON.parse(options.body));
      return reply(commands.length === 1 ? [1, "ok", 0] : 1);
    });
    const work = () => failure ? Promise.reject(new Error("provider failed")) : Promise.resolve(Response.json({ ok: true }));
    if (failure) await assert.rejects(withUsageBudget("transcribe", work), /provider failed/);
    else assert.equal((await withUsageBudget("transcribe", work)).status, 200);
    assert.equal(commands[0][0], "EVAL");
    assert.equal(commands[1][0], "ZREM");
    assert.equal(commands[1][1], commands[0][4]);
    assert.equal(commands[1][2], commands[0].at(-1));
  });
}

test("release failure preserves completed materials", async () => {
  let n = 0;
  const { withUsageBudget } = load(async () => {
    if (n++) throw new Error("unavailable");
    return reply([1, "ok", 0]);
  });
  const response = await withUsageBudget("generate", async () => Response.json({ materials: "saved" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).materials, "saved");
});

test("production instances share keys; preview has a separate budget", async () => {
  const keys = [];
  for (const environment of ["production", "production", "preview"]) {
    const { withUsageBudget } = load(async (_url, options) => {
      const cmd = JSON.parse(options.body);
      if (cmd[0] === "EVAL") keys.push(cmd[3]);
      return reply([0, "daily", 1]);
    }, { VERCEL_ENV: environment });
    await withUsageBudget("generate", async () => assert.fail());
  }
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});

const visitorRequest = (headers) => new Request("https://example.test/api/generate", { method: "POST", headers });

test("admission includes a hashed per-visitor key and allowance, with the lease id last", async () => {
  const commands = [];
  const { withUsageBudget, USAGE_BUDGETS } = load(async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return reply(commands.length === 1 ? [0, "visitor", 60] : 1);
  }, { VERCEL_ENV: "production" });
  await withUsageBudget("generate", async () => assert.fail(), visitorRequest({ "x-real-ip": "203.0.113.7" }));
  const [eval_, , numKeys, siteKey, activeKey, visitorKey, ...args] = commands[0];
  assert.equal(eval_, "EVAL");
  assert.equal(numKeys, 3);
  assert.equal(siteKey, "lecture-studio:{usage-production}:generate:daily");
  assert.equal(activeKey, "lecture-studio:{usage-production}:generate:active");
  assert.match(visitorKey, /^lecture-studio:\{usage-production\}:generate:visitor:[0-9a-f]{32}$/);
  assert.doesNotMatch(visitorKey, /203|0\.113/);
  const budget = USAGE_BUDGETS.generate;
  assert.deepEqual(args.slice(0, 4), [budget.daily, budget.concurrent, budget.leaseSeconds, budget.perVisitor]);
  assert.match(args[4], /^[0-9a-f-]{36}$/);
});

test("visitors are separated by address, and the same address maps to the same visitor", async () => {
  const keys = [];
  const { withUsageBudget } = load(async (_url, options) => {
    const cmd = JSON.parse(options.body);
    if (cmd[0] === "EVAL") keys.push(cmd[5]);
    return reply([0, "busy", 1]);
  });
  for (const ip of ["198.51.100.1", "198.51.100.1", "198.51.100.2"]) {
    await withUsageBudget("label", async () => assert.fail(), visitorRequest({ "x-real-ip": ip }));
  }
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});

test("visitor pseudonyms rotate daily and depend on the server secret", () => {
  const { visitorId } = load();
  const day = Date.UTC(2026, 10, 2, 12);
  const id = visitorId("192.0.2.5", "secret-a", day);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(visitorId("192.0.2.5", "secret-a", day + 3_600_000), id);
  assert.notEqual(visitorId("192.0.2.5", "secret-a", day + 86_400_000), id);
  assert.notEqual(visitorId("192.0.2.5", "secret-b", day), id);
  assert.notEqual(visitorId("192.0.2.6", "secret-a", day), id);
});

test("the client address prefers x-real-ip, then the first x-forwarded-for entry", () => {
  const { clientAddress } = load();
  assert.equal(clientAddress(visitorRequest({ "x-real-ip": "192.0.2.1", "x-forwarded-for": "192.0.2.9" })), "192.0.2.1");
  assert.equal(clientAddress(visitorRequest({ "x-forwarded-for": " 192.0.2.2 , 10.0.0.1" })), "192.0.2.2");
  assert.equal(clientAddress(visitorRequest({})), "unknown");
});

// Optional real-store check: only isolated test keys, never the app's usage counters or AI providers.
test("Redis integration: atomic races, quota, stale leases and daily rollover", {
  skip: !process.env.LIMITS_KV_REST_API_URL || !process.env.LIMITS_KV_REST_API_TOKEN,
}, async () => {
  const { ADMIT_SCRIPT } = load();
  const prefix = `lecture-studio:{test-${randomUUID()}}`;
  const keys = [`${prefix}:daily`, `${prefix}:active`, `${prefix}:visitor:a`];
  const otherVisitor = `${prefix}:visitor:b`;
  async function command(args) {
    const res = await fetch(process.env.LIMITS_KV_REST_API_URL, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${process.env.LIMITS_KV_REST_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    assert.equal(res.ok && !("error" in data), true, "Redis command failed");
    return data.result;
  }
  const admit = (visitor = keys[2], visitorLimit = 100) =>
    command(["EVAL", ADMIT_SCRIPT, 3, keys[0], keys[1], visitor, 3, 2, 150, visitorLimit, randomUUID()]);
  try {
    const raced = await Promise.all(Array.from({ length: 8 }, admit));
    assert.equal(raced.filter((r) => r[0] === 1).length, 2);
    assert.equal(await command(["HGET", keys[0], "used"]), "2");
    // Expire both abandoned leases using the actual Lua cleanup path on the next admission.
    const members = await command(["ZRANGE", keys[1], 0, -1]);
    for (const member of members) await command(["ZADD", keys[1], 0, member]);
    assert.equal((await admit())[0], 1);
    assert.equal((await admit())[1], "daily");
    await command(["HSET", keys[0], "day", -1]);
    assert.equal((await admit())[0], 1);
    assert.equal(await command(["HGET", keys[0], "used"]), "1");
    // A visitor at its own limit is refused before using a site allowance or a slot.
    await command(["DEL", keys[1]]);
    assert.equal((await admit(otherVisitor, 1))[0], 1);
    assert.equal((await admit(otherVisitor, 1))[1], "visitor");
    assert.equal(await command(["HGET", keys[0], "used"]), "2");
    assert.equal(await command(["ZCARD", keys[1]]), 1);
  } finally {
    await command(["DEL", ...keys, otherVisitor]);
  }
});
