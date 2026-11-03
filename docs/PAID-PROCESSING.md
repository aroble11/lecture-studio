# Paid processing controls

## Emergency pause

`PAID_PROCESSING_ENABLED=false` stops new requests to `/api/transcribe`, `/api/generate`
(including Baseten open-weight generation), and `/api/label` before reading their bodies or calling providers.
The response is HTTP 503 with a message the current UI can display. Saved materials and the
page remain accessible. A future cached sample must not call these routes.

Unset or `true` permits normal processing. Other values pause processing so configuration
typos cannot silently enable paid work. Never use a `NEXT_PUBLIC_` variable for this control.

On Vercel, set the environment variable for the intended deployment environment and redeploy
for the change to take effect. Locally, update `.env.local` and restart the server.
This switch does not cancel requests already running and is not an instant global switch.
For immediate incident containment, use Vercel's firewall to deny the three paid routes.

## Shared allowances and concurrency

The server uses Upstash Redis via `LIMITS_KV_REST_API_URL` and `LIMITS_KV_REST_API_TOKEN`.
Use the write-capable REST token, not the read-only token or Redis connection URL.
Keep credentials server-side and out of Git. No transcripts, images, IPs, or profiles are stored here.

| Operation | Shared daily allowance | Active requests | Abandoned slot expiry |
| --- | --- | --- | --- |
| Transcription | 600 chunks | 12 | 150 seconds |
| Generation (Meta + Baseten combined) | 40 | 2 | 330 seconds |
| Image labeling (includes SAM fan-out) | 40 images | 2 | 90 seconds |

These are conservative demo defaults in `lib/usage-budget.ts`, not dollar budgets. Provider
retries/fallbacks can make several calls per admitted request. Provider spend caps remain a
separate financial backstop. Twelve transcription slots allow two six-chunk bursts.

Allowances are site-wide, not per visitor. They reset at midnight UTC. Production and preview
have separate counters; all deployments within each environment share counters. Local runs
use development counters. Daily allowance is reserved before provider work and is not refunded
on failures, since the provider may have billed them. Invalid input is rejected before admission.
Request size and field validation are documented in `REQUEST-LIMITS.md` and `INPUT-VALIDATION.md`.

A single atomic Redis script checks quota and active leases, then reserves both. Exhaustion
returns 429 with `Retry-After` and a `reason` of `daily` or `busy`; the browser waits out
`busy` transcription responses and treats `daily` as final (see `OPERATION-TIMEOUTS.md`). Missing credentials, store failures, timeouts, or unexpected
responses return 503 and do not start provider work. Admissions are not retried automatically.
An ambiguous timeout can conservatively consume quota/a slot until expiry.

Slots are released in `finally`, including provider failures. Failed releases preserve the result;
leases expire after the Vercel route's configured maximum duration plus 30 seconds. On another
host, enforce the same hard request deadlines or revise leases before relying on concurrency
limits. A labeling request can fan out to six concurrent SAM calls; the cap of two is on labeling
requests, not individual upstream requests. These controls do not cancel already-running work.

## Verification

Run `npm run test:usage`. Tests execute actual handlers and the budget wrapper with mocked
providers/store responses; they do not spend AI credits. The real Redis test is skipped unless
the two REST credentials are present. To run it locally after adding credentials to `.env.local`:

`node --env-file=.env.local --test tests/usage-budget.test.mjs`

That integration test uses only isolated, temporary test keys and deletes them afterwards.
It verifies the actual Lua script against racing admissions, daily quota, stale leases and rollover.
It consumes a small number of Redis commands, not AI credits. Keep eviction disabled so stored
counters survive until their intended expiry. Deploy/redeploy only after the integration passes.

Verified November 1, 2026: 34 offline tests passed; the live Redis integration passed
(including racing admissions, stale leases, quota exhaustion, and rollover). Lint and TypeScript
checks passed. The owner also ran a successful production build in their terminal; the agent's
execution environment encountered a Turbopack CSS worker crash.
