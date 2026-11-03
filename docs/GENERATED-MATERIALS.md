# Generated materials validation

Hardening item 5 treats both generation providers' output as untrusted. A provider response is
checked for structure, repaired where the fix is safe, validated, cleaned up (blank repair, answer
shuffling, timestamp correction), and validated again. Invalid primary output triggers the existing
fallback model; invalid open-weight output triggers its one same-provider retry. Either retry is
told which rule the previous attempt broke. If the final attempt is invalid, generation fails
instead of displaying or saving partial materials.

## Repairs before rejection

A paid generation is not discarded for a deviation that can be fixed without inventing content.
After the strict structural check, the server:

- trims surplus entries (more than 6 note sections or items, 5 quiz questions, 2 exit tickets,
  3 pacing observations, 4 content gaps, or 36 word-bank entries);
- clamps section and content-gap timestamps into the recording and makes section times
  non-decreasing;
- standardizes a blank of any underscore length to `_____`;
- drops an individual note item that has several blanks, repeats an earlier answer, or whose answer
  does not occur in its sentence, and drops sections left empty; and
- drops diagram notes for unexpected or repeated numbers.

Missing content is never invented: fewer than five quiz questions, a missing diagram note, no usable
note items, or an empty required field still rejects the attempt. Logs name the repairs made and the
rule an attempt broke (for example `invalid output (quiz: expected 5–5 entries)`), never generated
or transcript content.

## Final validation

Validation requires:

- one complete JSON object (a complete JSON code fence with no other content is tolerated),
  no surrounding prose, trailing data, or responses over 250,000 characters;
- every required schema field, the correct primitive/container type, no provider-added fields,
  nonblank trimmed strings, safe integers, bounded arrays, and strings no longer than 4,000
  characters;
- 1–6 ordered guided-note sections with 1–6 items each, unique answers, valid recording
  timestamps, and exactly one canonical `_____` blank in each final item;
- a missing blank is repaired only when the stated answer occurs as a whole phrase in the note;
  otherwise that item is dropped, and the response is rejected if no usable item remains;
- an optional word bank that contains every guided-note answer exactly once;
- exactly five quiz questions with exactly four distinct choices each and a valid 0-based answer
  index (the same choice may appear in different questions, such as "True" or a year);
- 1–2 exit-ticket questions, 1–3 pacing observations, 0–4 timestamped content gaps, and a
  complete bell ringer;
- exactly one diagram note for every expected numbered item, with no missing, duplicate, or
  unexpected numbers; without a diagram, diagram notes must be empty; and
- a completed standard-provider response, or an open-weight response that ended normally and
  was not refused, truncated, filtered, or missing.

These checks guarantee shape and internal consistency, not factual accuracy, pedagogical quality,
or faithfulness to the transcript. The prompt still requires transcript-grounded content, and the
teacher should review generated materials before classroom use.

Run `npm run test:generation` for offline validator, repair, retry-feedback, fallback/retry,
blank repair, timestamp, answer-shuffle, diagram, and completion-state coverage. Tests use provider stubs and spend no API
credits.
