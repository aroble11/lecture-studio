# Deployed browser acceptance

Hardening item 19 checks the deployed application in a real browser and turns confirmed failures
into regression coverage.

The November 2, 2026 pass covered the production home and privacy pages without uploading files,
requesting microphone access, or making paid provider calls.

Passed checks:

- The home page loaded with the expected heading, save status, provider-routing disclosure, and
  disabled transcription control before audio selection.
- The privacy link navigated to a page that accurately described Meta and Baseten routing, browser
  storage, and separate lecture/profile deletion.
- The teaching-profile dialog exposed labeled fields and closed through **Cancel** without saving.
- The browser console contained no warnings or errors during those checks.

The first pass found that **Upload audio** and **Add image** appeared only as generic text in the
accessibility tree. Their file inputs used `display: none`, had no IDs, and could not receive keyboard
focus. The remediation keeps each native file input visually minimized but focusable, connects an
explicit label with `htmlFor`, and shows a visible focus outline on the corresponding control. The
reference-image input is also associated with its explanatory text.

`tests/accessibility.test.mjs` prevents the file inputs from returning to `className="hidden"` and
requires the accessible names, descriptions, and focus-visible styling.
