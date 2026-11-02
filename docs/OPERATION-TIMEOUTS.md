# Operation timeout and retry budgets

Hardening item 7 replaces the OpenAI SDK's ten-minute timeout and two automatic retries with
explicit budgets that fit the server routes.

- All OpenAI-compatible clients set `maxRetries: 0`; retry and fallback behavior is owned by the
  application and is therefore predictable.
- Standard and Privacy Mode generation calls each have 135 seconds. Two sequential attempts use
  at most 270 seconds, reserving roughly 30 seconds inside the generation route's 300-second limit.
- Image-label planning calls each have 18 seconds. A primary attempt, one fallback, and the
  parallel SAM phase (15 seconds) fit inside the labeling route's 60-second limit.
- Browser transcription gives a chunk and its optional HTTP retry one shared 100-second deadline.
  A failure aborts every in-flight sibling chunk immediately and prevents new chunks from starting.
- Browser cancellation propagates through the API request to generation, labeling, and the ASR
  WebSocket. Aborted work releases its usage lease through the existing route cleanup.

These are wall-clock safety ceilings, not promises that providers will always respond that quickly.
Timeouts return the existing controlled operation error and can be retried by the teacher.

Run `npm run test:timeouts` for offline provider-option, fallback-budget, sibling-cancellation, and
pre-cancelled ASR coverage. Tests use stubs and spend no API credits.

Verified locally: 6 timeout/cancellation tests, 11 generation-validation tests, 4 operation-
revision tests, and 113 existing offline tests passed; the one optional live Redis integration
test was skipped. Lint, TypeScript, and the owner's production build passed.
