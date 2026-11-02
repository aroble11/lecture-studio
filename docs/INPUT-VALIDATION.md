# Incoming data validation

Hardening item 4 validates known request fields before usage admission and paid provider work.
Invalid fields return JSON errors with status 400; incorrect media types return 415. Invalid
entries are rejected instead of silently dropped or truncated. Body-byte limits still apply first.

- JSON routes require application/json (case-insensitive; charset parameters accepted) and a
  non-null object body. Raw transcription requires application/octet-stream with non-empty,
  even-length PCM16 bytes. The server cannot prove the sample rate/channel count of headerless PCM.
- Generation requires 1–10,000 turns, each with finite numeric startMs/endMs, nonnegative
  ordered times, end at or after start, and at most 90 minutes. Starts must be nondecreasing;
  overlapping turns are allowed. Text must be nonblank and at most 12,000 characters per turn,
  with at most 120,000 trimmed characters total. Zero-duration turns remain supported.
- Optional context must be an object. Subject is limited to 100 characters, grade 50,
  objective/standards 500 each, and style/classNotes 600 each. Optional blank strings are omitted.
  Vocabulary and ASR keywords allow at most 50 nonblank strings of at most 80 characters each;
  terms are trimmed and deduplicated. Malformed terms are rejected, not silently discarded.
- Privacy must be a boolean if supplied. Optional diagram input must have 1–12 items with unique
  integer numbers from 1–12 and nonblank labels of at most 80 characters. Summary is optional
  and limited to 300 characters. Explicit null optional objects are rejected.
- Unknown properties are ignored when constructing clean prompt inputs; they still count
  toward the request-byte cap. They cannot select arbitrary providers or set server options.
- Images must have canonical base64 in a JPEG/PNG/WebP data URL. File signatures must match
  the declared format. Sharp validates metadata and decodes the actual pixels with strict
  warnings and an input-pixel cap. Images must be single-frame and no larger than 1600 × 1600,
  matching the existing browser preparation limit. Image data is never fetched from a caller URL.

Sharp 0.35.5 was already installed transitively through Next.js and is now a direct dependency.
This validates image structure, not image meaning, instructional correctness, or permissions.
Generated model output validation remains hardening item 5.

Run `npm run test:usage` for malformed fields, timing/count boundaries, actual image decoding,
and checks that rejected inputs never use quota or call paid services.

Verified locally: 113 offline tests passed, including actual JPEG/PNG/WebP decoding. Lint
and TypeScript checks passed. The separate live Redis integration is skipped in this offline
run; no budget logic changed in item 4. The owner ran a successful production build in their
terminal. Deployment is pending.
