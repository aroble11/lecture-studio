# Class video and whiteboard moments

A teacher can upload a recording of a lesson they taught (MP4 or MOV, up to 8 GB and 90 minutes). The video
itself never leaves the browser.

## Reading the sound (`lib/video-audio.ts`)

- Camera files usually keep their index (`moov` box) at the end. The browser reads only the top-level box
  headers to find it, hands just the index to mp4box (2.4.1, pinned) to learn where each audio frame sits,
  and then reads the audio frames in bounded 8 MB windows. The video is never loaded into memory.
- WebCodecs `AudioDecoder` decodes the frames; they are mixed to mono and resampled to 24 kHz in ~10 s
  blocks, then transcribed exactly like an audio upload (`/api/transcribe`, Meta).
- Needs WebCodecs audio decoding: current Chrome or Edge, recent desktop Firefox, or Safari 26+. Other
  browsers get a plain message suggesting an audio upload. Fragmented MP4 and non-MP4 containers get a
  "save it as MP4" message.

## Suggesting moments (`lib/board-frames.ts`)

- The browser skims the video (one 640-px snapshot every 5 s, wider for long videos) and splits each
  snapshot into 16-px patches: clean board, board with writing, or hidden (a person, the wall, furniture).
- The board has a memory: hidden patches keep their last seen state, so standing in front of the board is
  not an erase. An erase is a step where at least 30% of the remembered writing is seen clean again.
- One moment is suggested per board: the frame with the most board visible among those holding at least
  85% of that board's writing. Near-empty boards are skipped; at most six are suggested.
- The teacher keeps up to four (each kept drawing is one labeling request) or adds a moment with the
  scrubber.

## Lifting a drawing

- For each moment, nearby frames (from when that board began, at most 30 s back, and 2.5 s ahead) fill in
  what a person was covering. Within ±3 s the clearest view of each patch wins; older frames only fill
  patches still unseen, so an earlier board cannot bleed in.
- Cameras with automatic framing zoom and pan as the teacher moves. Frames whose board edge has moved, or
  that need any shift to line up with the chosen moment, are skipped, so writing is never doubled; a small
  area behind the teacher can stay blank instead.
- The composite is cleaned against the board's own local brightness (which also removes glare), cropped
  to the main cluster of writing (patches seen clean at some point, which leaves out the board's frame,
  tray, and far-off signs), and saved as marker on white.

## Labeling and pairing

- Kept drawings are sent to `/api/label` with `board: true`. Board mode asks Muse Wonder to decide whether
  the crop is a drawing or diagram (tables, arrows, number lines, sketches) or only writing, and to name and
  place up to six parts. SAM is skipped because it cannot find handwriting.
- Drawings appear under the guided-notes section whose start time is the latest at or before the moment.
  Boards that are mostly writing are not paired, so the notes are not repeated.
- Teachers can move, rename, add, and remove the numbered labels (**Edit labels**; up to six per drawing,
  and a drawing always keeps at least one). Removing a label renumbers the rest. The student view and student
  print show one numbered blank per label.

## Tests

`tests/video-audio.test.mjs` (box scanning, read windows, messages) and `tests/board-frames.test.mjs`
(patch states, erase detection, picking, lifting helpers, alignment). The tuning was checked against a real
6:51 webcam lecture with automatic framing; see the roadmap for remaining limits.
