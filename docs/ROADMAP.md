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

## Record video on the site

**Idea:** a **Record video** button beside **Record audio**, so a teacher can point a laptop or tablet at the
board and capture a class video without a separate camera app. Today video is uploaded (MP4/MOV) and only audio
is recorded on the site.

**Why it was deferred (November 3, 2026):** about 1–1.5 hours, and every risk is in real browsers (camera
permission, memory on long recordings, Safari's format), so it could not be proven before the submission
deadline. Teachers can record with the Windows Camera app or a phone and upload the MP4. Design:

1. **Two recorders on one camera-and-microphone stream, started together:** an audio-only `MediaRecorder` that
   feeds the existing transcription path, and a 720p video recorder (about 1.5 Mbps, roughly 1 GB per 90 minutes)
   for whiteboard moments. The separate audio recorder is needed because Chrome, Edge, and Firefox record WebM,
   which `lib/video-audio.ts` (MP4/MOV only) does not read. Starting both together keeps drawing times aligned
   with the transcript.
2. **Video length:** WebM from `MediaRecorder` has no stored duration, so `suggestBoardMoments` in
   `lib/board-frames.ts` currently stops with "This video's length couldn't be read." Pass the known recording
   length in, or patch the WebM header after recording.
3. **Keeping it:** recordings over 100 MB are not saved in the browser, so the video is lost on refresh. Show
   **Save recording** (already built for audio; extend `recordingExtension` for video types) and warn before the
   page closes while an unsaved video exists.
4. **Limits:** raise the video size cap (audio recording stops at 300 MB / 90 minutes) and keep the 90-minute limit.
5. **Screen:** a small live preview, a tip to point the camera at the board and away from students, and the same
   permission, stop, and cleanup rules as `docs/RECORDING-LIFECYCLE.md`.
6. **Tests:** lifecycle doubles for both recorders, and manual checks in Chrome/Edge, Firefox, and Safari.

## Recover whiteboard strokes the automatic cleanup drops

A per-drawing **Show original (skip cleanup)** toggle shipped on November 4, 2026 (beside **Edit labels**):
the lift keeps the cropped-but-uncleaned frame and the checkbox swaps the shown and printed image to it, so a
teacher can recover faint strokes the brightness cleanup removed. It is display-only and opt-in per board.

Still deferred, because each is larger and was found too close to the deadline to add and test safely:

1. **Stroke-preserving cleanup:** make the local-brightness binarization in `lib/board-frames.ts` adaptive
   (e.g. Sauvola with a safety margin), or back off cleaning in any patch where stroke detection sees writing
   in the raw crop but not the cleaned one, so faint strokes are not dropped in the first place.
2. **Fill patches hidden behind the teacher:** today the lift *skips* any nearby frame whose board edge moved
   (camera auto-framing). Registering those frames (a homography) and warping them into the chosen moment would
   let occluded patches be filled from more of the footage — the one case the "show original" toggle cannot fix,
   because those pixels were never captured.
3. **Single-clean-frame pick:** let the teacher choose one fully-visible frame and skip compositing for that
   board, which sidesteps both failure modes when a clean end-of-lecture frame exists.
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
