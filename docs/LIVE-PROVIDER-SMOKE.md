# Live paid-provider smoke test

Hardening item 18 adds a deliberately manual end-to-end check for the configured Meta and Baseten
services. It is not part of `npm test` or GitHub Actions and cannot spend credits without the explicit
`--confirm-paid` flag.

The smoke test uses the ignored local fixtures `test-audio/clip.wav` and
`test-images/pons_test.png`. It verifies, in order:

1. Meta transcription returns timestamped turns.
2. Meta image planning and SAM segmentation return a valid diagram result.
3. Meta materials generation returns a complete validated result.
4. Baseten open-weight generation returns a complete validated result without falling back to Meta.

It prints only timings, model names, and item counts. It does not print or save transcripts, image
labels, or generated materials. The test does send the fixture audio, image, transcript, and lesson
context to the providers described on the app's privacy page, and it reserves normal shared usage
allowances in Upstash.

Start the local application with its normal `.env.local`, then run:

```powershell
npm run dev
npm run smoke:live -- --confirm-paid
```

Optional `--base-url=`, `--audio=`, and `--image=` arguments override the defaults. Use only reviewed,
non-sensitive fixtures. A passing smoke test establishes current integration compatibility; it does
not establish provider retention terms, district approval, long-lecture endurance, or browser UI
acceptance.

## Verified November 2, 2026

The reviewed default fixtures completed all four stages successfully through the local Next.js
routes and configured Upstash controls:

- Meta transcription: 19.1 seconds; 2 turns validated.
- Meta image planning and SAM segmentation: 14.8 seconds; 5 diagram items validated.
- Meta `muse-wonder-1.0` materials generation: 38.0 seconds; 5 quiz items and 5 diagram notes validated.
- Baseten Muse Spark Open generation: 6.5 seconds; 5 quiz items and 5 diagram notes validated.

No transcript, label text, or generated classroom content was printed or saved by the smoke command.
