# Workspace Provider

### Inline shell templates in TS — tsc does not copy non-TS assets to dist/
**Date:** 2026-04-17
**Context:** Building a reusable post-receive hook installer. The intuitive approach — co-locate `post-receive.sh` next to `install-hook.ts` and load it via `readFileSync(fileURLToPath(import.meta.url))` — works fine under `tsx` (dev) and even under `tsc` at build time, but the compiled `dist/providers/workspace/install-hook.js` blows up at runtime because `tsc` does not copy `.sh` files into `dist/`. The assets-copy script in `package.json` doesn't exist in this repo.
**Lesson:** When a provider needs a non-TS asset (shell script, SQL, text template), prefer inlining it as a TS template literal over loading from a co-located file. Template literals escape `$` as `\$` — `sh -n <generated-file>` confirms valid syntax. If you must load from a file, add a `postbuild` script that copies the asset pattern into `dist/` and verify `npm run build` actually produces the file. Delete the separate asset file if you inline — two sources of truth for the same script is a drift bug waiting to happen.
**Tags:** workspace, tsc, dist, assets, templates, hooks, build

### `git stash` with only untracked files is a no-op — `git stash pop` will restore someone else's old stash
**Date:** 2026-04-17
**Context:** Wanted to test base-branch behavior by stashing my in-progress changes. Ran `git stash` (without `-u`) when all my changes were in new/untracked files. It silently succeeded with "No local changes to save." Then `git stash pop` restored `stash@{0}` — which was an old stash from a completely different branch — producing merge conflicts across ~8 unrelated files.
**Lesson:** When stashing new/untracked files, always use `git stash -u` (or `git stash -u -- <paths>`). Before `git stash pop`, run `git stash list` and confirm `stash@{0}` is actually yours. When temporarily testing base-branch state, a safer alternative is to use `git worktree add` on the base commit, or simply move the new files out of the tree (`mv file /tmp/`).
**Tags:** git, stash, untracked, workflow

### K8s RemoteTransport must use NATS IPC, not GCS staging — pods have no network
**Date:** 2026-03-16
**Context:** GCS RemoteTransport's `diff()` read from a `_staging/` GCS prefix that nothing wrote to, so `workspace.commit()` always found zero changes. Pods can't upload to GCS directly (no network security invariant). The fix: agent sends changes via NATS IPC `workspace_release` action to host, which stores them in memory. RemoteTransport.diff() returns and consumes stored changes.
**Lesson:** When designing cross-boundary data flows in k8s mode, always route through NATS IPC to the host process. Pods cannot reach external services (GCS, APIs) directly. The pattern: agent diffs locally → serializes via IPC → host stores/processes → host persists to external storage. Base64 encoding is necessary for binary-safe transport over NATS JSON payloads. Chunk at ~800KB to stay within NATS 1MB default max payload.
**Tags:** workspace, gcs, k8s, nats, remote-transport, no-network, ipc

### Orchestrator must remember userId from mount for use during commit
**Date:** 2026-03-14
**Context:** User workspace changes weren't appearing in GCS. The orchestrator's `commit()` method built a `ScopeContext` without `userId`, so `scopeId('user', ctx)` fell back to `sessionId` instead of the actual user ID. The backend diffed the wrong directory and found no changes.
**Lesson:** Any state needed for commit (like `userId`) must be stored during `mount()` and retrieved during `commit()`. The workspace orchestrator's scope tracking (`sessionScopes`) and ID resolution (`sessionUserIds`) are separate maps — keep them in sync (both populated during mount, both cleaned during cleanup).
**Tags:** workspace, orchestrator, commit, userId, scope-resolution, shared.ts
