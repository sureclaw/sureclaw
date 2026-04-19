# Workspace Provider

### Mirror seeding must be all-or-nothing — partial config leaves a poisoned repo
**Date:** 2026-04-18
**Context:** git-http `ensureMirror()` does `clone --mirror` then two `git config` steps to unset the mirror flag and restore a single-ref fetch refspec. When any of those config steps failed mid-sequence, the on-disk repo still had `HEAD` and looked valid to the next call (`existsSync(HEAD) === true` → `alreadySeeded = true`), but `remote.origin.mirror=true` was still set — so every subsequent push failed forever with `--mirror can't be combined with refspecs`.
**Lesson:** When bootstrapping an on-disk resource through multiple steps that a later call will short-circuit on, wrap the whole sequence in try/catch and tear the resource down on any failure. For `ensureMirror`: rm the local path on mid-seed failure so the next call re-clones cleanly. Also: add to the in-memory "seeded" set only AFTER all steps succeed, not before.
**Tags:** workspace, git-clone, mirror, idempotency, recovery

### `child.stdin.end(input)` needs an `'error'` listener, always
**Date:** 2026-04-18
**Context:** `execFileNoThrow` piped `opts.input` via `child.stdin.end(opts.input)` with no error listener. When the child exited before consuming all of stdin (e.g. EPIPE on `head -c 10`, `false`, or any early-exit command), Node emitted `'error'` on the stream; with no listener, it became an unhandled stream error that crashes the process. Silent while pipes fit in the kernel buffer, catastrophic once they don't.
**Lesson:** Whenever you hand stdin data to a spawned child via `child.stdin.end()` or `.write()`, attach `child.stdin.on('error', () => {})` BEFORE writing. EPIPE and ECONNRESET on stdin are normal (the child chose to exit) and shouldn't crash the parent — the child's exit status is already reported via the execFile callback. Don't skip this because "the child always reads all stdin" — that's an input-dependent assumption that will break on the wrong day.
**Tags:** execFile, stdin, EPIPE, node-streams, error-handling

### `git update-index --remove` needs `GIT_WORK_TREE` even against a bare repo
**Date:** 2026-04-18
**Context:** Building the `commitFiles` primitive that applies file writes/deletes to a bare repo's index via plumbing commands, using a throwaway `GIT_INDEX_FILE`. `hash-object --stdin`, `update-index --cacheinfo`, `write-tree`, and `commit-tree` all work fine with only `GIT_DIR` set. But `git update-index --remove <path>` (and `--force-remove`) fails with `fatal: this operation must be run in a work tree` — even though it only touches the index, not the filesystem.
**Lesson:** When driving git plumbing against a bare repo with a custom `GIT_INDEX_FILE`, always set `GIT_WORK_TREE` to a throwaway empty tempdir. The path need not contain any files — blobs come from the object store. Without it, path-style index mutations (`--remove`) refuse to run. Set it once alongside `GIT_DIR`/`GIT_INDEX_FILE` and forget about it.
**Tags:** workspace, git-plumbing, bare-repo, update-index, GIT_WORK_TREE

### `git clone --mirror` locks out single-ref pushes; unset `remote.origin.mirror` after
**Date:** 2026-04-18
**Context:** git-http's `commitFiles` seeds a local mirror of the remote bare repo via `git clone --mirror <url>` (matches `server-init.ts::getBareRepoPath`), then pushes the new commit back with `git push origin refs/heads/main`. Push failed with `fatal: --mirror can't be combined with refspecs` because `--mirror` sets `remote.origin.mirror=true` and that config rejects any explicit refspec on push.
**Lesson:** After `git clone --mirror`, unset `remote.origin.mirror` and restore a normal fetch refspec (`git config remote.origin.fetch '+refs/heads/*:refs/heads/*'`) if the caller needs to push individual refs. The repo stays bare and keeps the mirror semantics on fetch, but regains single-ref push. Alternative: use a regular clone and manage `--bare` layout yourself; `--mirror` is only worth the config gymnastics when you genuinely want it to track every ref type.
**Tags:** workspace, git-clone, mirror, push, refspec

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
