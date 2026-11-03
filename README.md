# Lecture Studio

Lecture Studio records or uploads a lecture and turns it into classroom materials. It can transcribe
audio or the sound of a class video, lift whiteboard drawings out of that video and pair them with the
guided notes, label an optional classroom image, generate teacher-facing materials, and keep the current
lecture in the browser between refreshes.

What a teacher can do:

- **Add a lecture:** record with the microphone, upload audio, upload a class video (MP4/MOV; only the
  sound is transcribed), or open the built-in **Try a sample lecture** (no provider calls).
- **Whiteboard moments:** from a class video, the browser suggests the fullest board before each erase,
  lifts the writing off the board, and pairs kept drawings with the matching notes section.
- **Edit:** correct the transcript, and move or rename the numbered labels on drawings and pictures.
- **Generate:** guided notes, a 5-question check for understanding, an exit ticket, a bell ringer, a
  label-the-picture activity, and teacher-only pacing and content-gap feedback.
- **Print or save as PDF:** a student copy (no answers) or a teacher copy (answer key and feedback).

The interface follows the browser's light or dark setting, with a Match browser / Light / Dark switch.

## Requirements

- Node.js 24 (the version used by CI)
- npm
- Meta API credentials for transcription, image labeling, and standard materials generation
- Baseten credentials only when open-weight materials generation is enabled
- An Upstash Redis database for shared usage and concurrency limits

## Local setup

1. Install the locked dependencies:

   ```powershell
   npm ci
   ```

2. Copy `.env.example` to `.env.local`, then provide the credentials for the services you intend to
   use. Do not commit `.env.local`.

3. Start the development server:

   ```powershell
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000).

## Environment variables

All variables are server-only. Do not rename them with a `NEXT_PUBLIC_` prefix.

| Name | Required for | Notes |
| --- | --- | --- |
| `META_API_KEY` | Transcription, image labeling, and standard generation | Never sent directly to the browser. |
| `META_API_BASE_URL` | Image labeling and standard generation | Use the Meta-compatible API endpoint supplied for those services. |
| `BASETEN_API_KEY` | Open-weight materials generation | Not required for standard Meta generation. |
| `LIMITS_KV_REST_API_URL` | All paid API routes | Upstash REST API URL. |
| `LIMITS_KV_REST_API_TOKEN` | All paid API routes | Use the write-capable REST token, not the read-only token. |
| `PAID_PROCESSING_ENABLED` | Optional emergency control | Unset or `true` enables processing; `false` pauses new paid requests. Invalid values fail closed. |

Vercel supplies `VERCEL_ENV`; the app uses it to keep production, preview, and development usage
counters separate. It should not be added manually for normal deployments.

## Data flow

1. **Browser capture:** microphone audio, uploaded audio or class video, lesson details, and an optional
   image begin in the teacher's browser. A class video never leaves the browser.
2. **Transcription:** the browser converts audio (or the sound read out of a video) to mono 24 kHz PCM
   chunks and sends them to `/api/transcribe`; the server sends those chunks to Meta.
3. **Image labeling:** when requested, `/api/label` sends the image and lesson context to Meta. Whiteboard
   moments are found and lifted in the browser; only drawings the teacher keeps are sent, in board mode.
4. **Materials generation:** `/api/generate` sends the transcript and lesson context either to Meta
   or, when open-weight generation is selected, to Baseten. That selection changes generation only;
   transcription and image labeling still use Meta.
5. **Browser persistence:** the current lecture and teacher profile are stored locally in the browser.
   Audio up to 100 MB may be stored in IndexedDB; other session data uses browser storage. **Start
   over** deletes the current lecture, while **Delete profile** removes the separate teacher profile.
6. **Usage controls:** Upstash stores only shared counters, per-visitor daily counters, and temporary
   concurrency leases. Visitor counters are keyed by a daily-rotating keyed hash of the network
   address (never the address itself) and expire within 48 hours. The app does not put transcripts,
   images, profiles, or IP addresses in that database.

Feature details: [class video and whiteboard moments](docs/VIDEO-AND-WHITEBOARD.md),
[printing](docs/PRINTING.md), and [the sample lecture](docs/SAMPLE-LECTURE.md). Planned future work is
listed in the [roadmap](docs/ROADMAP.md).

See [Privacy and data flow](docs/PRIVACY-DATA-FLOW.md), [paid processing controls](docs/PAID-PROCESSING.md),
and [request limits](docs/REQUEST-LIMITS.md) for the exact boundaries and failure behavior.

## Quality checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm test` runs the offline suite and does not make paid provider calls. One real Redis integration
test runs only when the two `LIMITS_KV_REST_API_*` variables are available. The root-level
`test-*.mjs` files are manual provider probes and are intentionally excluded from `npm test`.

`npm run test:e2e` runs browser tests against the production build (run `npm run build` first). It
starts the app with paid processing switched off and mocks every `/api` response in the browser, so
it never contacts a provider. Install its browser once with `npx playwright install chromium`.

Pushes to `main` and pull requests run all five checks in GitHub Actions. See
[continuous integration](docs/CONTINUOUS-INTEGRATION.md) for details.

## Deployment

The project is deployed on Vercel. Configure the environment variables for the intended Vercel
environments, keep secrets out of source control, and redeploy after changing server variables.
Production should also retain the Vercel firewall rule for the paid API routes and provider-side
spending limits; the application's shared allowances are operational safeguards, not financial caps.

## Browser support

The audio path includes compatibility fallbacks and a 90-minute processing limit, but microphone
permissions, recording codecs, and long-session memory behavior still require real-browser testing.
Use the manual matrix in [long-lecture and browser compatibility](docs/BROWSER-COMPATIBILITY.md).
