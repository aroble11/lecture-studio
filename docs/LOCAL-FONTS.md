# Local production fonts

Hardening item 16 removed the production build's dependency on Google Fonts. The Sunny Desk redesign
keeps that guarantee.

- The interface font is Nunito (variable weight, Latin subset), stored at
  `app/fonts/nunito-latin-wght-normal.woff2` and loaded with `next/font/local`. It was copied from the
  `@fontsource-variable/nunito` 5.3.0 package; its SIL Open Font License ships beside it as
  `app/fonts/Nunito-OFL.txt`. No package is added for it.
- Monospace timestamps still use Geist Mono from Vercel's `geist` npm package, locked by
  `package-lock.json`.
- `next build` downloads no font CSS or binaries.

Run `node --test tests/fonts.test.mjs` to verify the layout cannot silently return to
`next/font/google` and that both CSS variables remain applied.
