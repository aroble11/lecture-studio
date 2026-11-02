# Microphone recording lifecycle

Hardening item 11 prevents silent permission waits, runaway recordings, and microphone resources
remaining active after the capture screen closes.

- The capture UI enters an explicit **Waiting for microphone permission** state while the browser
  prompt is unresolved. Other lecture-changing controls remain locked during that request.
- A request that resolves after the component closes or after a newer request is discarded, and all
  tracks from its returned stream are stopped.
- Browser recordings request a 128 kbps audio bitrate and stop automatically at 90 minutes or 300
  MB. The completed recording remains available, and the UI explains which limit stopped it.
- Manual stop, automatic stop, recorder errors, failed startup, and component unmount all stop the
  media tracks. Timers and recorder/stream references are also cleared.
- Recorder errors discard the partial recording rather than presenting it as a successful capture.

Run `npm run test:recording` for duration and byte boundary checks, active-recorder and media-track
cleanup coverage, and capture-UI lifecycle assertions. These tests use local doubles and require no
microphone or network access.

Verified locally: 3 recording tests plus 149 existing offline tests passed; the one optional live
Redis integration test was skipped. Lint, TypeScript, and the owner's production build passed,
including the static privacy route. A real-browser microphone-permission acceptance check remains a
separate manual test.
