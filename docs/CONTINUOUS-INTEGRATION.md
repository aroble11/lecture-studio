# Continuous integration

Hardening item 12 adds a single offline test command and a tracked GitHub Actions quality gate.

- `npm test` runs only `tests/*.test.mjs`. The live provider probes in the repository root are not
  auto-discovered, so CI cannot spend API credits.
- Pushes to `main` and pull requests run locked dependency installation, a production dependency
  advisory audit, lint, TypeScript, the offline test suite, and a production build on Node.js 24.
- The TypeScript command runs `next typegen` first so global App Router helpers such as
  `LayoutProps` exist in a clean checkout, as required by Next.js 16.
- The workflow receives no provider or Redis secrets and has read-only repository permissions.
- Checkout does not persist Git credentials. Third-party actions are pinned to the full immutable
  commit SHAs for their verified v7 releases rather than mutable version tags.
- Concurrent runs for the same ref are cancelled, and the job has a 15-minute timeout.
- `npm run audit:prod` fails on moderate or higher advisories in packages shipped with the app.
  Development-tool findings are evaluated separately instead of weakening the production gate.

The action versions were checked against the official `actions/checkout` and `actions/setup-node`
release pages on November 1, 2026. The CI configuration has regression tests in
`tests/ci-config.test.mjs`.

Verified locally after the clean-checkout type-generation fix: `npm test` passed 156 tests with zero
failures; the one optional live Redis integration test was skipped. The owner's initial unified run
passed all 155 tests that existed before the added type-generation regression assertion. Lint and
TypeScript also passed. The workflow's production-build step is verified by GitHub Actions after push.

Dependency-audit scope and the current development-only exception are documented in
`docs/DEPENDENCY-SECURITY.md`.
