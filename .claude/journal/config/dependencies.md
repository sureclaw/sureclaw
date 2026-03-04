# Config: Dependencies

Package management, lock file maintenance, npm/CI sync issues.

## [2026-03-04 03:17] — Fix npm ci failure: remove malformed sqlite-vec-linux-arm64 stub from lock file

**Task:** Investigate and fix recurring CI failure: `npm ci` fails with "Missing: sqlite-vec-linux-arm64@ from lock file"
**What I did:** Diagnosed that `sqlite-vec-linux-arm64@0.1.6` was never published to npm (only alpha versions exist), while `sqlite-vec@0.1.6` declares it as an optional dependency. The lock file had a broken nested stub entry at `node_modules/sqlite-vec/node_modules/sqlite-vec-linux-arm64` with only `{"optional": true}` — missing version, resolved, integrity fields. All other platform variants (darwin-arm64, darwin-x64, linux-x64, windows-x64) had proper top-level entries. Removed the malformed stub entry.
**Files touched:** package-lock.json (modified)
**Outcome:** Success — `npm ci` passes, all 2298 tests pass
**Notes:** This is an upstream bug in the `sqlite-vec` npm package — it declares `sqlite-vec-linux-arm64@0.1.6` as an optional dep but that version was never published (only 0.1.7-alpha.x versions exist). The stub entry confuses npm's sync validation.
