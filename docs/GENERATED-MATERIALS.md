# Generated materials validation

Hardening item 5 treats both generation providers' output as untrusted. A provider response is
validated before cleanup and validated again after blank repair, answer shuffling, and timestamp
correction. Invalid primary output triggers the existing fallback model; invalid open-weight
output triggers its one same-provider retry. If the final attempt is invalid, generation fails
instead of displaying or saving partial materials.

Validation requires:

- one complete JSON object (a complete JSON code fence with no other content is tolerated),
  no surrounding prose, trailing data, or responses over 250,000 characters;
- every required schema field, the correct primitive/container type, no provider-added fields,
  nonblank trimmed strings, safe integers, bounded arrays, and strings no longer than 4,000
  characters;
- 1–6 ordered guided-note sections with 1–6 items each, unique answers, valid recording
  timestamps, and exactly one canonical `_____` blank in each final item;
- a missing blank is repaired only when the stated answer occurs as a whole phrase in the note;
  an absent answer rejects the response instead of creating an unanswerable blank;
- an optional word bank that contains every guided-note answer exactly once;
- exactly five quiz questions with exactly four distinct choices each, a valid 0-based answer
  index, and no reused choice across questions;
- 1–2 exit-ticket questions, 1–3 pacing observations, 0–4 timestamped content gaps, and a
  complete bell ringer;
- exactly one diagram note for every expected numbered item, with no missing, duplicate, or
  unexpected numbers; without a diagram, diagram notes must be empty; and
- a completed standard-provider response, or an open-weight response that ended normally and
  was not refused, truncated, filtered, or missing.

These checks guarantee shape and internal consistency, not factual accuracy, pedagogical quality,
or faithfulness to the transcript. The prompt still requires transcript-grounded content, and the
teacher should review generated materials before classroom use.

Run `npm run test:generation` for offline validator, fallback/retry, blank repair, timestamp,
answer-shuffle, diagram, and completion-state coverage. Tests use provider stubs and spend no API
credits.

Verified locally: 10 generation-validation tests and 113 existing offline tests passed; the one
optional live Redis integration test was skipped. Lint, TypeScript, and the owner's production
build passed.
