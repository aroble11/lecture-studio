# Local production fonts

Hardening item 16 removes the production build's dependency on Google Fonts.

- The root layout imports Geist Sans and Geist Mono from Vercel's official `geist` npm package.
- The package includes the font files and SIL Open Font License, so `next build` does not need to
  download font CSS or binaries from Google.
- The existing `--font-geist-sans` and `--font-geist-mono` variables remain unchanged, preserving
  the Tailwind font mappings and the app's visual hierarchy.
- The package is locked by `package-lock.json`; clean installs and CI receive the same font version.

Run `node --test tests/fonts.test.mjs` to verify the layout cannot silently return to
`next/font/google` and that both CSS variables remain applied.
