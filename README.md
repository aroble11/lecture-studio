# Lecture Studio

Lecture Studio records or uploads a lecture and turns it into classroom materials. It can transcribe
audio or the sound of a class video, lift whiteboard drawings out of that video and pair them with the
guided notes, label an optional classroom image, generate teacher-facing materials, and keep the current
lecture in the browser between refreshes.

What a teacher can do:

- **Add a lecture:** record with the microphone (with Pause/Continue and **Save recording**), upload
  audio, upload a class video (MP4/MOV; only the sound is transcribed), or open the built-in **Try a
  sample lecture** (no provider calls).
- **Whiteboard moments:** from a class video, the browser suggests the fullest board before each erase,
  lifts the writing off the board, and pairs kept drawings with the matching notes section.
- **Edit:** correct the transcript; move or rename the numbered labels on drawings and pictures, and add
  or remove labels on whiteboard drawings (students get one blank per label).
- **Generate:** guided notes, a 5-question check for understanding, an exit ticket, a bell ringer, a
  label-the-picture activity, and teacher-only pacing and content-gap feedback.
- **Print or save as PDF:** a student copy (no answers) or a teacher copy (answer key and feedback).

The page shows one step at a time beside a **Your progress** list that marks each step done, current, or
next, with live status while something runs. The interface follows the browser's light or dark setting,
with a Match browser / Light / Dark switch.

## Built for the Meta Global AI Developer Hackathon

Built solo during the Meta Global AI Developer Hackathon (October 27 – November 4, 2026), Indie track,
theme *Build for Your World*. Live app: https://lecture-studio-nine.vercel.app/

**For judges:** the fastest way to try it is the live app — click **Try a sample lecture** to see finished
materials with no account or API keys. Running it locally needs your own Meta API key (plus Baseten for the
open-weight option and Upstash Redis for usage limits); see [Local setup](#local-setup) below.

**Starting point:** the repository was created on October 27, and the app began from the standard
`create-next-app` template (commit `7296a6d`, October 28). Everything else was built during the event.

**Which Meta model does what:**

| Step | Meta model | Where |
| --- | --- | --- |
| Transcription | Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | `lib/meta-asr.ts`, `app/api/transcribe/route.ts` |
| Materials generation | Muse Wonder (`muse-wonder-1.0`), falling back to Muse Spark (`muse-spark-1.3`) | `lib/generate.ts`, `app/api/generate/route.ts` |
| Picture labeling | Muse Wonder plans the labels; SAM 3.1 (`sam-3.1`) finds each object precisely | `lib/label.ts`, `app/api/label/route.ts` |
| Whiteboard drawings | Muse Wonder in board mode names the parts of each kept drawing | `lib/label.ts` (board mode) |
| Open-weight option | Muse Spark Open (`meta-models/muse-spark-open`) on Baseten, with no Meta fallback | `lib/generate.ts`, `lib/config.ts` |

All model IDs live in `lib/config.ts`. How the pieces fit:

- **Realtime model as a batch transcriber.** Muse Voice Transcribe takes a live stream only. The browser
  converts audio (or a class video's sound) to 24 kHz mono, cuts it at quiet moments into ~60 s chunks,
  and the server streams each chunk at 2× real time, 6 at once. Lesson vocabulary biases spelling, and
  the turn times feed the pacing feedback.
- **Two models for one picture.** Wonder decides what is worth labeling and roughly where; SAM 3.1 returns
  precise boxes; the closest match wins.
- **Whiteboard moments are found for free.** The browser picks the fullest board before each erase and
  lifts the drawing (teacher, glare, and background removed); only drawings the teacher keeps go to Wonder.
- **Output that teachers can trust.** Generated materials are strictly validated and repaired; a failed
  rule is named in the retry, and output that still fails never reaches the screen.

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
