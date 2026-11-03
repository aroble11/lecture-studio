# Roadmap

Future development ideas that were discussed and deliberately deferred. Each entry says why it matters and
what it touches, so it can be picked up without rediscovering the design.

## Choose which materials to generate

**Idea:** in **Get your materials**, show a button for each kind of material (guided notes, quiz, exit ticket,
bell ringer, label-the-picture, pacing and gaps), all unselected, and generate only the ones the teacher picks.
A teacher who wants only handouts would spend fewer tokens (guided notes are the largest part, so a
handouts-only run saves roughly a third of the output).

**Why it was deferred (November 3, 2026):** every part is currently produced by one request with a fixed output
format, and several safety layers assume all parts exist. An estimated 2–3 hours of careful work:

1. **Request:** a strictly validated "which materials" field in `/api/generate` (`lib/input-validation.ts`).
2. **Prompt and output format:** build the output schema and the instructions in `lib/generate.ts` from the
   chosen parts. Changing the prompt changes output quality, so confirm with a few explicitly approved paid runs
   on both Meta and the open-weight model (the repair rules were tuned on measured runs).
3. **Output checks and repair:** `lib/materials-validation.ts` must accept a missing part only when it was not
   chosen, and still reject it otherwise, so malformed output can never reach teachers.
4. **Saved lectures:** `lib/session-store.ts` must apply the same rule on restore and keep loading older saves,
   which always contain every part. Record the chosen parts with the result.
5. **Screen and print:** hide tabs and print sections for parts not generated. Pacing uses the guided-notes
   sections and whiteboard drawings attach to them, so both need a fallback when notes are not chosen.
6. **Tests:** update the generation, persistence, and browser tests.

## Other ideas

- **Print a single section:** a "Print: Everything / Just this tab" choice beside the print buttons. Printing
  currently always produces the full packet (student or teacher copy).
- **Automatic whiteboard moments with Meta vision:** a possible paid option that lets a vision model choose
  board moments. Today moments are suggested locally for free and the teacher approves them.
- **Board drawings in generation:** pass kept drawings' labels to materials generation as context. Today the
  drawings are paired with the notes after generation.
- **Keep large videos across a refresh:** videos over 100 MB are not saved in the browser, so new whiteboard
  moments cannot be picked after a refresh without re-uploading (kept moments are saved).
- **District-hosted open-weight model:** run the open-weight materials step on a server the district controls.
  Today it runs on Baseten, and transcription and image labeling always use Meta.

## Known limits to verify

- Real-browser microphone matrix (Chrome/Edge, Firefox, Safari) and a 60–90 minute endurance run.
- Class-video audio needs WebCodecs audio decoding (current Chrome/Edge, recent desktop Firefox, Safari 26+);
  only tested in Chrome/Edge on Windows so far. iPhone HEVC video may play sound but not pictures in some
  Windows browsers, which disables whiteboard moments for that file.
- Whiteboard lifting skips frames when a camera's automatic framing zooms or pans, so a small area behind the
  teacher can stay blank; strokes under strong light glare can be lost.
- Board-mode label positions are the model's estimates; teachers can move them with **Edit labels**.
