# Long-lecture and browser compatibility

Hardening item 13 protects the browser-specific audio path and exercises the 90-minute boundary
without making paid provider calls.

- Uploaded audio duration is read from media metadata before Web Audio decoding. Files over 90
  minutes are rejected before the browser allocates a full decoded audio buffer. If a browser cannot
  read container metadata, the existing post-decode duration check remains the fallback.
- Decoded channels are explicitly mixed to mono and resampled to 24 kHz. This preserves the ASR
  contract even when a browser uses its device sample rate instead of the requested AudioContext
  rate.
- Microphone recording prefers 128 kbps but retries with the browser's native defaults if that
  option is rejected. The browser remains responsible for choosing its supported container/codec.
- Automatic recording stops use a one-second safety margin so event-loop delay cannot produce a
  recording just beyond the 90-minute processing limit.
- The offline suite simulates a full 90-minute timeline at a reduced sample rate and verifies that
  chunks are contiguous, complete, and never exceed 75 seconds. It also covers resampling,
  multi-channel mixing, metadata cleanup, and recorder-option fallback.

The metadata approach uses widely available `HTMLMediaElement.duration`, `loadedmetadata`, and
`preload="metadata"` behavior. Browser recording still needs a real acceptance pass because codec
availability, permission UI, and device capture cannot be proven by Node-based tests.

## Manual acceptance matrix

For each available desktop browser (current Chrome or Edge, Firefox, and Safari on macOS):

1. Allow the microphone, record 5–10 seconds, stop, play it back, and transcribe it.
2. Deny microphone permission and confirm the page explains how to retry.
3. Upload one supported local audio file and confirm duration, playback, and transcription.
4. Refresh after capture and confirm the saved-audio status is accurate.

Record the browser name/version, operating system, audio format, and result. A real 60–90 minute
lecture remains a separate manual endurance test; the automated timeline test validates chunk
planning but does not establish browser memory usage or provider throughput.
