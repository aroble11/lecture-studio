# Privacy wording and provider selection

Hardening item 9 narrows the former “Privacy Mode” promise to the behavior the app can verify:
open-weight **materials generation**.

- Before recording or upload, the capture screen names the destination and payload for each stage:
  Meta transcription, optional Meta image labeling, and Meta or Baseten materials generation.
- Selecting the open-weight option sends the transcript, lesson details, profile guidance, and any
  diagram-label terms to Muse Spark Open on Baseten instead of Meta for generation only. It does
  not change transcription or image-label routing.
- Generated results use the badge **Open-weight generation**, not a broad privacy claim.
- The privacy page explains external routing, browser persistence, the 100 MB saved-audio limit,
  and the separate **Start over** and **Delete profile** controls. It explicitly avoids unverified
  claims about provider retention, district approval, or legal compliance.
- The generation API validates the requested mode before checking credentials. Open-weight
  generation requires only BASETEN_API_KEY; standard generation requires only META_API_KEY.

The request field and saved-session property remain named privacy for backward compatibility;
their documented meaning is now the narrower provider selection above.

The browser tests (`npm run test:e2e`) check the rendered disclosures on the capture screen and the
privacy page, and that the open-weight badge appears on open-weight results. Provider-selection
regression tests are in `npm run test:usage`; all calls are stubbed and spend no API credits.

## Class videos and whiteboard moments

- A class video stays in the browser. Only its sound is read out (in the browser) and sent to Meta for
  transcription in the same PCM chunks as any other recording.
- Whiteboard moments are found, captured, and lifted off the board in the browser. Only the drawings the
  teacher keeps (up to four) are sent to Meta's image labeling, with the same lesson details as a
  reference image. The video picker reminds teachers to check that no students are visible.
- Videos larger than 100 MB are not saved in the browser; kept drawings are saved with the lecture.
- The privacy page has a "Class videos — stay in your browser" entry, checked by the browser tests'
  disclosure check together with the other routing entries.
