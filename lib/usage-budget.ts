import { randomUUID } from "node:crypto";

/** Site-wide demo allowances, shared by all visitors and deployments in an environment.
 * A transcription unit is one chunk; a labeling unit includes its SAM fan-out.
 * Failed admitted operations still count, since a provider may already have billed them.
 */
export const USAGE_BUDGETS = {
  transcribe: { daily: 600, concurrent: 12, leaseSeconds: 150 },
  generate: { daily: 40, concurrent: 2, leaseSeconds: 330 },
  label: { daily: 40, concurrent: 2, leaseSeconds: 90 },
} as const;
type Operation = keyof typeof USAGE_BUDGETS;

// One atomic admission: racing instances cannot each claim the final quota/slot.
// Use Redis time for both UTC rollover and stale-lease cleanup.
export const ADMIT_SCRIPT = `
local now = tonumber(redis.call('TIME')[1])
local day = math.floor(now / 86400)
local used = 0
if tonumber(redis.call('HGET', KEYS[1], 'day')) == day then
  used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
end
if used >= tonumber(ARGV[1]) then
  return {0, 'daily', (day + 1) * 86400 - now}
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  return {0, 'busy', math.max(1, tonumber(oldest[2]) - now)}
end
redis.call('HSET', KEYS[1], 'day', day, 'used', used + 1)
redis.call('EXPIRE', KEYS[1], 172800)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), ARGV[4])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]) + 60)
return {1, 'ok', 0}
`;

type Store = { url: string; token: string };
function storeConfig(): Store {
  const url = new URL(process.env.LIMITS_KV_REST_API_URL ?? "");
  const token = process.env.LIMITS_KV_REST_API_TOKEN;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !token) {
    throw new Error("Usage store configuration invalid");
  }
  return { url: url.toString(), token };
}

async function command(store: Store, args: (string | number)[]): Promise<unknown> {
  // Never retry admissions: a lost response may follow a successful reservation.
  const response = await fetch(store.url, {
    method: "POST", cache: "no-store", redirect: "error",
    headers: { Authorization: `Bearer ${store.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args), signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("Usage store request failed");
  const data = await response.json();
  if (!data || typeof data !== "object" || "error" in data || !("result" in data)) {
    throw new Error("Usage store response invalid");
  }
  return data.result;
}

function unavailable(): Response {
  return Response.json({ error: "Paid processing is temporarily unavailable. Please try again later." }, {
    status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" },
  });
}

/** Invoke only after validation, immediately around paid work. Missing/broken storage fails closed. */
export async function withUsageBudget(operation: Operation, work: () => Promise<Response>): Promise<Response> {
  const budget = USAGE_BUDGETS[operation];
  // Preview builds share a preview budget, separate from production; local runs use development.
  const environment = process.env.VERCEL_ENV ?? "development";
  const prefix = `lecture-studio:{usage-${environment}}:${operation}`;
  const activeKey = `${prefix}:active`;
  const lease = randomUUID();
  let store: Store;
  try {
    store = storeConfig();
    const result = await command(store, ["EVAL", ADMIT_SCRIPT, 2, `${prefix}:daily`, activeKey,
      budget.daily, budget.concurrent, budget.leaseSeconds, lease]);
    if (!Array.isArray(result) || result.length !== 3 ||
        !Number.isInteger(result[2]) || result[2] < 0) return unavailable();
    const [allowed, reason, retry] = result;
    if (allowed === 0 && (reason === "daily" || reason === "busy")) {
      // `reason` lets clients wait out "busy" while treating "daily" as final.
      return Response.json({ reason, error: reason === "daily"
        ? "Today's shared demo allowance for this operation has been reached. Please try again tomorrow (UTC)."
        : "The service is busy. Please wait before trying again." }, {
        status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(Math.max(1, retry)) },
      });
    }
    if (allowed !== 1 || reason !== "ok") return unavailable();
  } catch {
    // Do not log fetch errors/response bodies: they may contain credentials or endpoint details.
    console.warn("[usage-budget] admission unavailable");
    return unavailable();
  }

  try {
    return await work();
  } finally {
    try {
      // Only remove our own lease. Daily usage is never refunded automatically.
      await command(store, ["ZREM", activeKey, lease]);
    } catch {
      // Preserve the completed result; an abandoned lease expires after the function deadline.
      console.warn("[usage-budget] lease release unavailable; awaiting expiry");
    }
  }
}
