# Workflow

### Incomplete optional dependency stubs in package-lock.json break `npm ci`
**Date:** 2026-03-04
**Context:** CI failed on every PR with "Missing: sqlite-vec-linux-arm64@ from lock file". The lock file had an incomplete nested stub entry (`{"optional": true}` with no version/resolved/integrity) for a platform-specific optional dependency that was never published to npm.
**Lesson:** When `npm ci` reports "Missing: <package>@ from lock file", check if the package entry in `package-lock.json` is complete. Platform-specific optional dependencies can end up as broken stubs if (a) `npm install` was run on a different platform, or (b) the package version was never published. Remove the stub entry — npm will skip unavailable optional deps gracefully when the entry is absent, but a malformed stub causes a sync validation failure.
**Tags:** npm, package-lock, optional-dependencies, ci, sqlite-vec

### Explicit `permissions` in GitHub Actions replaces ALL defaults — always include `contents: read`
**Date:** 2026-02-25
**Context:** GitHub Pages workflow had `permissions: { pages: write, id-token: write }` but `actions/checkout` silently failed because `contents: read` was missing
**Lesson:** When setting `permissions` at the workflow or job level in GitHub Actions, you override ALL default token permissions. Only the permissions you list are granted. `actions/checkout` needs `contents: read` to clone the repo. Always include it when using explicit permissions. The checkout step may fail silently or produce cryptic errors without it.
**Tags:** github-actions, permissions, pages, checkout, ci
