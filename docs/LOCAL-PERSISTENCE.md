# Local persistence status and consistency

Hardening item 8 makes browser persistence visible and revision-safe.

- The page reports when lecture data is saving, saved, or unsaved. Failed session or audio writes
  show a retry action instead of being logged silently.
- A storage read failure is not treated as an empty session. Automatic saving stays off until the
  teacher explicitly retries, avoiding a blank overwrite of potentially recoverable work.
- Audio is marked saved only after IndexedDB confirms the transaction. Failed writes remain
  retryable.
- Every newly selected or recorded audio blob has a revision identifier. The session stores that
  identifier and restoration attaches audio only when the two revisions match, preventing metadata
  from being paired with a different recording after an interrupted save.
- Audio over 100 MB is explicitly excluded from browser persistence and removed from the saved-audio
  slot. The UI warns that it will disappear on refresh while the smaller transcript, lesson details,
  image, and generated materials can still be saved.
- Existing saves remain compatible. Legacy audio is assigned a revision and rewritten once.
- The teacher profile remains separate from the current lecture and now has its own confirmed
  **Delete profile** action. Storage failures are shown in the profile card.

Run `npm run test:persistence` for offline write-failure, retry, revision-match, oversized-audio,
and profile-deletion coverage. Tests use in-memory browser-storage doubles and no network services.

Verified locally: 6 persistence tests, 6 timeout/cancellation tests, 11 generation-validation
tests, 4 operation-revision tests, and 113 existing offline tests passed; the one optional live
Redis integration test was skipped. Lint, TypeScript, and the owner's production build passed.
