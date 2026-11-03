# Operation timeout and retry budgets

Hardening item 7 replaces the OpenAI SDK's ten-minute timeout and two automatic retries with
explicit budgets that fit the server routes.

- All OpenAI-compatible clients set `maxRetries: 0`; retry and fallback behavior is owned by the
  application and is therefore predictable.
- Standard and open-weight generation calls each have 135 seconds. Two sequential attempts use
  at most 270 seconds, reserving roughly 30 seconds inside the generation route's 300-second limit.
- Image-label planning calls each have 18 seconds. A primary attempt, one fallback, and the
  parallel SAM phase (15 seconds) fit inside the labeling route's 60-second limit.
- Browser transcription gives a chunk and its optional HTTP retry one shared 100-second deadline.
  A failure aborts every in-flight sibling chunk immediately and prevents new chunks from starting.
- A 429 "busy" response (shared transcription slots full) or a firewall 429 is not a failure. The
  chunk returns to the queue, all workers pause for the server's `Retry-After` (bounded to 2–20
  seconds, plus jitter), and one parallel worker is dropped per busy response until 30 seconds pass
  without one. A pause ends early as soon as another chunk finishes, since that frees a slot.
  Waiting does not count against the 100-second chunk deadline. Transcription gives up
  only after 3 minutes with no finished chunk. A 429 whose `reason` is `daily` or `visitor` stays final.
- When transcription stops early, finished chunks are kept in memory. Retrying the same audio with
  the same keywords sends only the missing chunks, which avoids re-billing finished work. Changing
  the audio or keywords, or refreshing the page, starts fresh.
- Browser cancellation propagates through the API request to generation, labeling, and the ASR
  WebSocket. Aborted work releases its usage lease through the existing route cleanup.

These are wall-clock safety ceilings, not promises that providers will always respond that quickly.
Timeouts return the existing controlled operation error and can be retried by the teacher.

Run `npm run test:timeouts` for offline provider-option, fallback-budget, sibling-cancellation,
pre-cancelled ASR, busy-retry, and resume coverage. Tests use stubs and spend no API credits.
