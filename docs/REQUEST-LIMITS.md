# Request body limits

All three paid handlers use `lib/request-body.ts` before reserving quota or starting paid work.

| Route | Maximum actual body bytes |
| --- | --- |
| `/api/transcribe` | 4,000,000 |
| `/api/generate` | 1,000,000 |
| `/api/label` | 4,000,000 |

The cap includes the entire request, including JSON context, whitespace, and extra fields.
The reader counts stream bytes regardless of `Content-Length`. A declared oversized request
is cancelled immediately; a stream that exceeds the cap is cancelled at its first excessive
chunk. Oversized data is not copied into the application buffer, decoded, or parsed. A fixed-size
buffer bounds retained application memory, including when the sender supplies many tiny chunks.
The hosting platform and stream source may perform their own buffering independently.

Excess returns 413. Malformed length headers, interrupted reads, invalid UTF-8 JSON, and invalid
JSON syntax return 400. Encoded/compressed bodies return 415; the clients send uncompressed
JSON or raw PCM. No JSON parsing happens until the actual byte cap has been enforced.

The body reader focuses on bytes and JSON syntax. The handlers also validate JSON fields,
transcript timing, and image contents as documented in `INPUT-VALIDATION.md` (hardening item 4).
The reader does not impose a timeout on a slow uploader.

Run `npm run test:usage` for stream cancellation, boundary values, misleading/missing headers,
UTF-8 byte counting, malformed JSON, and all three route integrations. Providers are mocked;
these request-limit tests do not spend API credits or contact Redis.

Verified November 1, 2026: all 56 offline tests, lint, and TypeScript checks passed.
The owner ran a successful production build in their terminal. The agent's execution
environment encountered the previously observed Turbopack CSS-worker crash.
