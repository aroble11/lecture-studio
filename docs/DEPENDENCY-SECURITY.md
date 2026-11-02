# Dependency security

Hardening item 17 adds a repeatable production dependency advisory gate and records the current
development-tool assessment.

## Enforced production boundary

`npm run audit:prod` checks the lockfile with development dependencies omitted and fails on any
moderate, high, or critical advisory. GitHub Actions runs it immediately after `npm ci`, before lint,
tests, or the production build. The check queries npm's current advisory service, so it can detect a
new advisory without a source-code change.

Verified November 2, 2026: the production tree contained zero known advisories.

## Development-tool exception

The full audit reported `GHSA-g3hv-75wg-m249`, a moderate glob-pattern denial of service advisory,
through ESLint tooling only:

- `minimatch@10.2.6` is nested under `@typescript-eslint/typescript-estree`.
- `minimatch@3.1.5` is used by ESLint and several plugins, but the advisory's named optimizer and
  `optimizationLevel` implementation do not exist in that older release. The published affected
  range is being questioned upstream.
- Both copies are marked development-only in `package-lock.json`; application code does not import
  ESLint or minimatch, and `npm audit --omit=dev` is clean.
- The 10.x call is limited to TypeScript ESLint's optional `allowDefaultProject` patterns. This
  repository does not enable that option. TypeScript ESLint also rejects the advisory's `**/../`
  pattern shape for that setting.

No override was added. Forcing `minimatch@11` would violate the versions declared by the current
ESLint ecosystem, and a global override would break plugins that still call the older CommonJS
function API. npm's automatic suggestion to downgrade ESLint and `eslint-config-next` is likewise
incompatible with this Next.js 16 project.

Recheck the full `npm audit` when `eslint-config-next` or TypeScript ESLint publishes a dependency
chain compatible with `minimatch@11.0.1` or later, or when the GitHub advisory range is clarified.
Until then, do not accept untrusted ESLint configuration or glob patterns outside the reviewed
repository and keep CI's job timeout enabled as a resource backstop.

References:

- [GitHub advisory GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [Advisory-range clarification issue](https://github.com/github/advisory-database/issues/10811)
