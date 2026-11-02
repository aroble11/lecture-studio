# Stale operation protection

Hardening item 6 prevents asynchronous work for an older lecture revision from changing the
current lecture.

- Transcription and generation receive revision tickets. Selecting or recording new audio,
  changing lesson inputs, changing the profile or open-weight option, replacing/removing an image,
  or starting over invalidates the revision and aborts active network requests.
- Progress, errors, transcripts, and generated materials are applied only while their ticket is
  still current. A late response can finish, but it cannot change the UI or saved session.
- Reference-image labeling has a separate revision guard so replacement/removal aborts its request
  and old labels cannot attach to the new image.
- Conflicting capture, lesson, image, transcription, and generation controls are disabled while
  transcription, recording, or generation is active, and while session restoration is pending.
- The exact transcript, duration, and lesson context used for each generated result are saved with
  it. The materials view uses that snapshot instead of whichever transcript is currently selected.
  Existing saved sessions remain compatible and receive a snapshot derived from their saved data.
- A delayed session restore is discarded if a newer lecture revision already exists, and pending
  requests are invalidated when the component unmounts.

Run `npm run test:state` for offline revision, cancellation, late-response, and cleanup coverage.
The tests make no network requests and use no API credits.

Verified locally: 4 operation-revision tests, 10 generation-validation tests, and 113 existing
offline tests passed; the one optional live Redis integration test was skipped. Lint, TypeScript,
and the owner's production build passed.
