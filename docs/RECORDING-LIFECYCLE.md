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
- **Pause** and **Continue** pause and resume the same recording (`MediaRecorder.pause()`/`resume()`). Paused
  time is not recorded and does not count toward the 90-minute limit; the timer shows recorded time only. The
  microphone stays open while paused, so the browser still shows it in use, and the screen says nothing is
  being recorded. **Stop** works while paused. Browsers without pause support show only **Stop**.
- After a recording stops, **Save recording** downloads a copy to the teacher's device, named with the
  date and time (for example `Lecture recording (Nov 3, 2-05 PM).webm`; Safari saves `.m4a`). It appears
  only for recordings made on the site, not for uploads or the sample. Chrome, Edge, and Firefox record
  WebM or Ogg audio, which VLC and browsers play; some Windows media players do not.

Run `npm run test:recording` for duration and byte boundary checks, active-recorder and media-track
cleanup coverage, and capture-UI lifecycle assertions. These tests use local doubles and require no
microphone or network access.

A real-browser microphone-permission acceptance check remains a separate manual test (see
`BROWSER-COMPATIBILITY.md`).
