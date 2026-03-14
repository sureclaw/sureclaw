# Acceptance Tests: Workspace Provider

**Plan document(s):** `docs/plans/2026-03-13-workspace-provider-design.md`, `docs/plans/2026-03-14-sandbox-workspace-permissions.md`
**Date designed:** 2026-03-13 (updated 2026-03-14)
**Total tests:** 18 (ST: 9, BT: 5, IT: 3, GKE: 1)

## Environment Notes

### Local
- `workspace: local` in `$TEST_HOME/ax.yaml`
- Workspace basePath: `$TEST_HOME/workspaces`
- Audit: file-based (`$TEST_HOME/data/audit/audit.jsonl`)
- EventBus: inprocess
- Sandbox: seatbelt

### K8s (kind)
- `workspace: local` in kind-values.yaml config block — GCS backend (`gcs.ts`) is implemented but requires a real GCS bucket, so kind clusters use the `local` backend on the host pod filesystem
- Workspace basePath: default (`~/.ax/workspaces` on the host pod, i.e. `/home/agent/.ax/workspaces`)
- Audit: database (PostgreSQL)
- EventBus: nats
- Sandbox: subprocess (agent-runtime pod)
- **Kind limitation:** Workspace data lives on the host pod's ephemeral filesystem. No PVC = no persistence across pod restarts. Acceptable for acceptance tests. Production GKE deployments should use `workspace: gcs` with a GCS bucket.

### K8s (GKE — production)
- `workspace: gcs` with `workspace.bucket` or `GCS_WORKSPACE_BUCKET` env var
- `sandbox: k8s` with pool controller enabled — sandbox pods claimed via NATS
- Authentication via GKE Workload Identity or `GOOGLE_APPLICATION_CREDENTIALS`
- Workspace data persists in GCS bucket at `gs://<bucket>/<prefix>/<scope>/<id>/`
- Local cache in tmpdir (`/tmp/ax-workspaces-gcs`) for overlay diff — ephemeral, rebuilt on mount
- Sandbox pods have `user-ws` and `agent-ws` emptyDir volumes (per sandbox-workspace-permissions plan)
- **Not tested in kind** — requires real GCS bucket and k8s sandbox pods. The GKE-specific tests (GKE-* section) must run against a real GKE cluster.
- Unit test coverage: `tests/providers/workspace/gcs.test.ts` (20 tests with mock bucket)

### Fixture Changes Required

**Local:** Copy `$FIXTURES/ax.yaml` to `$TEST_HOME/ax.yaml` then patch:
```yaml
providers:
  workspace: local

workspace:
  basePath: $TEST_HOME/workspaces
```

For BT-3 (none provider test), use a separate config with `workspace: none` (the original fixture default).
For BT-4 (oversized file test), also set `workspace.maxFileSize: 100`.

**K8s (kind):** The kind-values.yaml config block needs `workspace: local` and a workspace section added. The host pod runs the workspace provider using the local backend; basePath defaults to `~/.ax/workspaces`. (GCS backend is available via `workspace: gcs` but requires a real GCS bucket — not available in kind.)

## Summary of Acceptance Criteria

1. WorkspaceProvider interface has mount, commit, cleanup, activeMounts methods (Plan §3)
2. WorkspaceBackend sub-interface has mount, diff, commit methods (Plan §3.1)
3. Three workspace scopes: agent, user, session (Plan §2)
4. `none` provider is a no-op stub — workspace_mount tool not registered (Plan §9)
5. `local` provider uses hash-map snapshot for diff detection (Plan §9)
6. `gcs` provider downloads from GCS on mount, uploads on commit, uses snapshot diffing (Plan §9)
7. All three backends (none, local, gcs) registered in provider-map.ts static allowlist (Plan §10)
8. ProviderRegistry includes workspace field (Plan §10)
9. IPC schema for workspace_mount exists with scope validation (Plan §7)
10. workspace_mount IPC handler additively mounts scopes (Plan §7)
11. workspace_mount tool registered in tool catalog when provider != none (Plan §7)
12. Host auto-mounts previously remembered scopes on subsequent turns (Plan §4)
13. Commit pipeline applies structural checks before content scanning (Plan §6)
14. Commit pipeline defaults: 10MB file, 500 files, 50MB total, default ignore patterns (Plan §6)
15. Binary file detection rejects files with null bytes (Plan §6)
16. Event hub events published for mount, commit, and rejections (Plan §8)
17. Cleanup removes session scope tracking; agent/user scopes persist (Plan §5)
18. safePath used for all file operations from input (Plan §9, Security)
19. Scanner integration — every file passes through scanner before persistence (Plan §13)
20. GKE end-to-end: sandbox tool call → GCS workspace volume mounted in sandbox → file edit → NATS release → workspace commit → GCS bucket updated (Plan §4, §5, §9, §12)

---

## Structural Tests

> Run by **local agent only** — these are environment-independent source code checks.

### ST-1: WorkspaceProvider interface exists with correct methods

**Criterion:** "WorkspaceProvider interface has mount, commit, cleanup, activeMounts methods" (Plan §3)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §3 Provider Interface

**Verification steps:**
1. Read `src/providers/workspace/types.ts` and check that the WorkspaceProvider interface exports mount, commit, cleanup, activeMounts
2. Verify WorkspaceMounts, CommitResult, ScopeCommitResult, FileRejection types exist
3. Verify WorkspaceScope type includes 'agent', 'user', 'session'

**Expected outcome:**
- [ ] WorkspaceProvider interface has mount(sessionId, scopes), commit(sessionId), cleanup(sessionId), activeMounts(sessionId)
- [ ] WorkspaceScope = 'agent' | 'user' | 'session'
- [ ] WorkspaceMounts has paths: Partial<Record<WorkspaceScope, string>>
- [ ] CommitResult has scopes: Partial<Record<WorkspaceScope, ScopeCommitResult>>
- [ ] ScopeCommitResult has status: 'committed' | 'rejected' | 'empty', filesChanged, bytesChanged, rejections

**Pass/Fail:** _pending_

### ST-2: WorkspaceBackend sub-interface exists with correct methods

**Criterion:** "WorkspaceBackend sub-interface has mount, diff, commit methods" (Plan §3.1)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §3.1 Backend Sub-Interface

**Verification steps:**
1. Read `src/providers/workspace/types.ts` and check that WorkspaceBackend interface exists
2. Verify mount(scope, id), diff(scope, id), commit(scope, id, changes) signatures
3. Verify FileChange type with path, type, content, size fields

**Expected outcome:**
- [ ] WorkspaceBackend has mount(scope: WorkspaceScope, id: string): Promise<string>
- [ ] WorkspaceBackend has diff(scope: WorkspaceScope, id: string): Promise<FileChange[]>
- [ ] WorkspaceBackend has commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void>
- [ ] FileChange has path: string, type: 'added' | 'modified' | 'deleted', content?: Buffer, size: number

**Pass/Fail:** _pending_

### ST-3: All three backends registered in provider-map.ts and exist on disk

**Criterion:** "All three backends (none, local, gcs) registered in provider-map.ts static allowlist" (Plan §10)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §10 Configuration

**Verification steps:**
1. Read `src/host/provider-map.ts` and verify workspace category exists
2. Check that none, local, and gcs entries are present
3. Verify paths point to correct modules
4. Verify all three source files exist: `src/providers/workspace/{none,local,gcs}.ts`

**Expected outcome:**
- [ ] provider-map.ts has workspace category with none, local, gcs entries
- [ ] Paths match: `../providers/workspace/none.js`, `../providers/workspace/local.js`, `../providers/workspace/gcs.js`
- [ ] All three source files exist on disk

**Pass/Fail:** _pending_

### ST-4: ProviderRegistry includes workspace field

**Criterion:** "ProviderRegistry includes workspace field" (Plan §10)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §10

**Verification steps:**
1. Read `src/types.ts` and verify ProviderRegistry includes `workspace: WorkspaceProvider`
2. Verify Config.providers includes workspace provider name
3. Verify WorkspaceProvider import from workspace types

**Expected outcome:**
- [ ] ProviderRegistry.workspace is typed as WorkspaceProvider
- [ ] Config.providers.workspace exists
- [ ] WorkspaceProvider is imported from `./providers/workspace/types.js`

**Pass/Fail:** _pending_

### ST-5: IPC schema for workspace_mount with scope validation

**Criterion:** "IPC schema for workspace_mount exists with scope validation" (Plan §7)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §7 Agent IPC Integration

**Verification steps:**
1. Read `src/ipc-schemas.ts` and verify WorkspaceMountSchema exists
2. Check that scopes field is z.array(z.enum(['agent', 'user', 'session']))
3. Verify the schema uses .strict() mode (via ipcAction helper)

**Expected outcome:**
- [ ] WorkspaceMountSchema exists with action: 'workspace_mount'
- [ ] scopes validates against ['agent', 'user', 'session'] enum
- [ ] Schema rejects unknown fields (strict mode via ipcAction)

**Pass/Fail:** _pending_

### ST-6: workspace_mount tool in tool catalog

**Criterion:** "workspace_mount tool registered in tool catalog when provider != none" (Plan §7)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §7

**Verification steps:**
1. Read `src/agent/tool-catalog.ts` and verify workspace_mount tool exists in TOOL_CATALOG
2. Check category is 'workspace_scopes' and singletonAction is 'workspace_mount'
3. Verify filterTools() includes workspace_scopes when hasWorkspaceScopes is true
4. Verify filterTools() excludes workspace_scopes when hasWorkspaceScopes is false

**Expected outcome:**
- [ ] workspace_mount tool in TOOL_CATALOG with singletonAction: 'workspace_mount'
- [ ] category: 'workspace_scopes'
- [ ] filterTools() conditionally includes based on hasWorkspaceScopes flag

**Pass/Fail:** _pending_

### ST-7: Shared orchestration implements commit pipeline defaults

**Criterion:** "Commit pipeline defaults: 10MB file, 500 files, 50MB total, default ignore patterns" (Plan §6)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §6 Commit Pipeline

**Verification steps:**
1. Read `src/providers/workspace/shared.ts` and check DEFAULT constants
2. Verify DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024 (10MB)
3. Verify DEFAULT_MAX_FILES = 500
4. Verify DEFAULT_MAX_COMMIT_SIZE = 50 * 1024 * 1024 (50MB)
5. Verify DEFAULT_IGNORE_PATTERNS includes .git/, node_modules/, venv/, __pycache__/, *.log, *.tmp, build/, dist/

**Expected outcome:**
- [ ] DEFAULT_MAX_FILE_SIZE = 10485760 (10MB)
- [ ] DEFAULT_MAX_FILES = 500
- [ ] DEFAULT_MAX_COMMIT_SIZE = 52428800 (50MB)
- [ ] DEFAULT_IGNORE_PATTERNS matches plan's list exactly

**Pass/Fail:** _pending_

### ST-8: Host workspace IPC handler exists and wires to providers.workspace

**Criterion:** "Host-side IPC handler mounts scopes, audits, returns paths" (Plan §7)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §7

**Verification steps:**
1. Read `src/host/ipc-handlers/workspace.ts` and verify workspace_mount handler
2. Check handler calls providers.workspace.activeMounts() and providers.workspace.mount()
3. Verify handler logs to audit provider
4. Verify additive scope behavior (merges new scopes with existing)

**Expected outcome:**
- [ ] workspace_mount handler exists in createWorkspaceHandlers
- [ ] Calls providers.workspace.activeMounts(sessionId) to check current state
- [ ] Calls providers.workspace.mount(sessionId, newScopes) for new scopes only
- [ ] Logs to providers.audit.log with action 'workspace_mount'
- [ ] Returns { mounted: [...allScopes], paths: mounts.paths }

**Pass/Fail:** _pending_

### ST-9: GCS backend implementation exists with correct structure

**Criterion:** "GCS backend downloads persisted state from GCS bucket on mount, uploads approved changes on commit" (Plan §9)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §9 Backend Implementations — `gcs`

**Verification steps:**
1. Read `src/providers/workspace/gcs.ts` and verify it exists
2. Check that `createGcsBackend(bucket, basePath, prefix)` is exported (for testability)
3. Verify `create(config)` factory function exists and lazily imports `@google-cloud/storage`
4. Check mount() downloads files from GCS via `bucket.getFiles({ prefix })` and writes to local cache
5. Check diff() uses snapshot-based change detection (same approach as local backend)
6. Check commit() uploads approved changes via `bucket.file(key).save()` and deletes via `bucket.file(key).delete()`
7. Verify `GcsBucketLike` interface is exported for mock injection in tests
8. Verify safePath() used for all local path construction from GCS key names
9. Verify `workspace.bucket` config or `GCS_WORKSPACE_BUCKET` env var is required

**Expected outcome:**
- [ ] `src/providers/workspace/gcs.ts` exists
- [ ] `createGcsBackend` exported with signature `(bucket: GcsBucketLike, basePath: string, prefix: string): WorkspaceBackend`
- [ ] `create(config)` factory lazily imports `@google-cloud/storage`
- [ ] mount() calls `bucket.getFiles()` and writes downloaded content to `safePath(basePath, scope, id)`
- [ ] commit() calls `bucket.file(key).save()` for added/modified and `.delete()` for deleted
- [ ] `GcsBucketLike` interface exported with `getFiles` and `file` methods
- [ ] Throws if neither `workspace.bucket` nor `GCS_WORKSPACE_BUCKET` is set
- [ ] Unit tests exist at `tests/providers/workspace/gcs.test.ts`

**Pass/Fail:** _pending_

---

## Behavioral Tests

> Run by **both** local and k8s agents. Same test logic, different send commands and side-effect checks.

### BT-1: Agent can mount workspace scopes via chat

**Criterion:** "Agent calls workspace_mount via IPC to request scopes" (Plan §4)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §4 Mount Behavior

**Setup:**
- Config must have `workspace: local`
- Workspace basePath configured (local: `$TEST_HOME/workspaces`, k8s: host pod default)

**Chat script:**
1. Send: `Mount my session workspace and the shared agent workspace so I can save files.`
   Expected behavior: Agent uses workspace_mount tool with scopes ['session', 'agent']
   Structural check: Audit log contains workspace_mount entry with scopes

**Expected outcome:**
- [ ] Agent response acknowledges workspace mount
- [ ] Audit log contains workspace_mount action with scopes including 'session' and/or 'agent'
- [ ] No errors in server logs

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| Audit | `grep workspace_mount "$TEST_HOME/data/audit/audit.jsonl"` | `kubectl exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log WHERE action='workspace_mount' ORDER BY timestamp DESC LIMIT 5;"` |
| Logs  | `grep -i workspace "$TEST_HOME/data/ax.log"` | `kubectl logs $HOST_POD \| grep -i workspace` |

**Session IDs:**
- Local: `acceptance:workspace:local:bt1`
- K8s: `acceptance:workspace:k8s:bt1`

**Pass/Fail:** _pending_

### BT-2: Agent can write files to workspace and they persist through commit

**Criterion:** "Workers cannot write directly to permanent storage. All writes go through the commit pipeline." (Plan §12)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §12 Trust Boundary

**Setup:**
- Config with `workspace: local`

**Chat script:**
1. Send: `Mount the agent workspace scope.`
   Expected behavior: Agent calls workspace_mount with ['agent']
   Structural check: Audit log has workspace_mount entry

2. Send: `Write a file called hello.txt with the content "Hello from workspace test" to the agent workspace.`
   Expected behavior: Agent uses workspace tool to write the file
   Structural check: File exists in workspace directory or workspace_write appears in audit

**Expected outcome:**
- [ ] Agent response confirms file was written
- [ ] Audit log shows workspace_write or workspace_write_file action
- [ ] File exists on disk at the workspace basePath under agent scope
- [ ] No errors in server logs

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| Audit | `grep workspace_write "$TEST_HOME/data/audit/audit.jsonl"` | `kubectl exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log WHERE action LIKE 'workspace_write%' ORDER BY timestamp DESC LIMIT 5;"` |
| File  | `find "$TEST_HOME/workspaces" -name hello.txt` | `kubectl exec $HOST_POD -- find /home/agent/.ax/workspaces -name hello.txt` |
| Logs  | `grep -i workspace "$TEST_HOME/data/ax.log"` | `kubectl logs $HOST_POD \| grep -i workspace` |

**Session IDs:**
- Local: `acceptance:workspace:local:bt2`
- K8s: `acceptance:workspace:k8s:bt2`

**Pass/Fail:** _pending_

### BT-3: none provider disables workspace tools

**Criterion:** "No-op stub — workspace_mount tool is not registered when this provider is active" (Plan §9)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §9

**Setup:**
- Config with `workspace: none` (the default — use unmodified fixture for this test)
- **Local:** Use a separate ax.yaml with `workspace: none` (or the original fixture)
- **K8s:** Deploy with config overriding `workspace: none` in Helm values

**Chat script:**
1. Send: `What tools do you have available? List them all.`
   Expected behavior: Agent lists available tools — workspace_mount should NOT be among them
   Structural check: Response text does not mention workspace_mount or workspace scope tools

**Expected outcome:**
- [ ] Agent response does not include workspace_mount tool
- [ ] Agent response does not include workspace write tools (or they are absent from the tool list)
- [ ] No errors in server logs

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| Logs  | `grep -i "workspace" "$TEST_HOME/data/ax.log"` | `kubectl logs $HOST_POD \| grep -i workspace` |

**Session IDs:**
- Local: `acceptance:workspace:local:bt3`
- K8s: `acceptance:workspace:k8s:bt3`

**K8s note:** This test requires a separate Helm deployment with `workspace: none`. The k8s agent should either:
(a) Use a separate namespace with modified values, or
(b) Run this test first before switching config.
Option (a) is cleaner — create a second namespace just for BT-3.

**Pass/Fail:** _pending_

### BT-4: Structural checks reject oversized files

**Criterion:** "Structural limits (file size, count, commit size) are enforced before scanning" (Plan §13)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §6

**Setup:**
- Config with `workspace: local` and `workspace.maxFileSize: 100` (100 bytes for testing)
- **Local:** Patch `$TEST_HOME/ax.yaml` to add `workspace.maxFileSize: 100`
- **K8s:** Add `workspace.maxFileSize: 100` to the Helm config block

**Chat script:**
1. Send: `Mount the agent workspace and write a file called big.txt containing 200 characters of the letter 'x' repeated.`
   Expected behavior: Agent mounts and writes; the commit pipeline rejects due to file size exceeding 100 bytes
   Structural check: Check audit/logs for rejection entries

**Expected outcome:**
- [ ] Commit pipeline rejects the file with reason mentioning file size
- [ ] workspace.commit.rejected event appears in logs
- [ ] File is NOT persisted in the final workspace directory (or is rejected in commit result)

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| Audit | `grep -i "reject\|commit" "$TEST_HOME/data/audit/audit.jsonl"` | `kubectl exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log WHERE action LIKE 'workspace%' ORDER BY timestamp DESC LIMIT 10;"` |
| Events | `grep "workspace.commit" "$TEST_HOME/data/ax.log"` | `kubectl logs $HOST_POD \| grep "workspace.commit"` |

**Session IDs:**
- Local: `acceptance:workspace:local:bt4`
- K8s: `acceptance:workspace:k8s:bt4`

**Pass/Fail:** _pending_

### BT-5: Ignore patterns filter out known directories

**Criterion:** "Ignore patterns are applied before the agent sees the diff" (Plan §13)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §6

**Setup:**
- Config with `workspace: local`

**Chat script:**
1. Send: `Mount the agent workspace. Then write two files: first write "module.exports = {}" to node_modules/test/index.js, and second write "console.log('hello')" to src/main.ts.`
   Expected behavior: Agent writes both files; commit pipeline rejects node_modules file but accepts src/main.ts
   Structural check: Only src/main.ts persists; node_modules file is rejected

**Expected outcome:**
- [ ] src/main.ts is persisted in the workspace
- [ ] node_modules/test/index.js is rejected with "matched ignore pattern" reason
- [ ] Rejection appears in audit or logs

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| File (good) | `find "$TEST_HOME/workspaces" -path "*/src/main.ts"` | `kubectl exec $HOST_POD -- find /home/agent/.ax/workspaces -path "*/src/main.ts"` |
| File (bad) | `find "$TEST_HOME/workspaces" -path "*/node_modules/*"` (should be empty) | `kubectl exec $HOST_POD -- find /home/agent/.ax/workspaces -path "*/node_modules/*"` (should be empty) |
| Events | `grep "workspace.commit" "$TEST_HOME/data/ax.log"` | `kubectl logs $HOST_POD \| grep "workspace.commit"` |

**Session IDs:**
- Local: `acceptance:workspace:local:bt5`
- K8s: `acceptance:workspace:k8s:bt5`

**Pass/Fail:** _pending_

---

## Integration Tests

> Run by **both** local and k8s agents. Same test logic, different send commands and side-effect checks.

### IT-1: Multi-turn workspace persistence across sessions

**Criterion:** "Agent and user scopes persist across sessions. Session scope is destroyed when session ends." (Plan §2, §5)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §2, §5

**Setup:**
- Config with `workspace: local`

**Sequence:**
1. [First session — write a file to agent workspace]
   Action: Send `Mount the agent workspace and write a file called persistent.txt with content "I should survive across sessions"` with first session ID
   Verify: File written, commit succeeds, audit log records mount + write

2. [End first session — cleanup]
   Action: (Session ends naturally — next request uses a different session ID)
   Verify: Agent scope data persists on disk

3. [Second session — verify file exists]
   Action: Send `Mount the agent workspace. Read the file persistent.txt and tell me its contents.` with second session ID
   Verify: Agent can read the file written in the first session

**Expected final state:**
- [ ] persistent.txt exists in the agent workspace directory
- [ ] Agent in second session can read and report the file's contents ("I should survive across sessions")
- [ ] Both sessions logged in audit

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| File  | `cat "$TEST_HOME/workspaces/agent/*/persistent.txt"` | `kubectl exec $HOST_POD -- cat /home/agent/.ax/workspaces/agent/*/persistent.txt` |
| Audit | `grep workspace "$TEST_HOME/data/audit/audit.jsonl" \| wc -l` (should be ≥3: 2 mounts + 1 write) | `kubectl exec $PG_POD -- psql -U ax -d ax -c "SELECT count(*) FROM audit_log WHERE action LIKE 'workspace%';"` |

**Session IDs:**
- Local: `acceptance:workspace:local:it1:turn1` (first), `acceptance:workspace:local:it1:turn2` (second)
- K8s: `acceptance:workspace:k8s:it1:turn1` (first), `acceptance:workspace:k8s:it1:turn2` (second)

**Pass/Fail:** _pending_

### IT-2: Scope escalation is additive within a session

**Criterion:** "Scope escalation is additive. Calling workspace_mount(['session']) then workspace_mount(['agent']) means both are active." (Plan §4)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §4

**Setup:**
- Config with `workspace: local`

**Sequence:**
1. [Mount session scope only]
   Action: Send `Mount only the session workspace scope. Do not mount agent or user scopes.`
   Verify: Audit shows workspace_mount with scopes: ['session']

2. [Add agent scope]
   Action: Send `Now also mount the agent workspace scope, in addition to the session scope that's already mounted.`
   Verify: Audit shows workspace_mount with scopes: ['agent'], allScopes includes both session and agent

3. [Write to both scopes]
   Action: Send `Write "session data" to session-file.txt in the session workspace and "agent data" to agent-file.txt in the agent workspace.`
   Verify: Both files written successfully

**Expected final state:**
- [ ] Both session and agent scopes are active for the session
- [ ] Both files exist in their respective scope directories
- [ ] Audit log shows additive mount behavior (two separate mount calls, second call adds agent while session remains)

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| Audit mounts | `grep workspace_mount "$TEST_HOME/data/audit/audit.jsonl"` (should show 2 entries) | `kubectl exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log WHERE action='workspace_mount' ORDER BY timestamp;"` |
| Agent file | `find "$TEST_HOME/workspaces/agent" -name agent-file.txt` | `kubectl exec $HOST_POD -- find /home/agent/.ax/workspaces/agent -name agent-file.txt` |
| Session file | `find "$TEST_HOME/workspaces/session" -name session-file.txt` | `kubectl exec $HOST_POD -- find /home/agent/.ax/workspaces/session -name session-file.txt` |

**Session IDs:**
- Local: `acceptance:workspace:local:it2`
- K8s: `acceptance:workspace:k8s:it2`

**Pass/Fail:** _pending_

### IT-3: Host auto-mounts remembered scopes on subsequent turns

**Criterion:** "Subsequent turns: Host remembers which scopes were mounted and pre-populates them automatically before sandbox spawn." (Plan §4)
**Plan reference:** 2026-03-13-workspace-provider-design.md, §4, §5

**Setup:**
- Config with `workspace: local`

**Sequence:**
1. [First turn — explicitly mount scopes]
   Action: Send `Mount the agent and session workspace scopes.`
   Verify: workspace_mount called, scopes active, audit entry logged

2. [Second turn — same session, scopes should auto-mount]
   Action: Send `Write "auto-mounted test" to auto.txt in the agent workspace. Do not mount any workspaces — they should already be available from the previous turn.`
   Verify: Agent can write to workspace without explicitly calling workspace_mount again

**Expected final state:**
- [ ] Second turn succeeds without explicit workspace_mount call from the agent
- [ ] auto.txt exists in agent workspace with content "auto-mounted test"
- [ ] Server logs show auto-mount of remembered scopes on second turn (workspace.mount event or `workspace_automount` log entry)

**Side-effect checks:**

| Check | Local | K8s |
|-------|-------|-----|
| File | `cat "$TEST_HOME/workspaces/agent/*/auto.txt"` | `kubectl exec $HOST_POD -- cat /home/agent/.ax/workspaces/agent/*/auto.txt` |
| Auto-mount log | `grep -i "automount\|workspace.mount" "$TEST_HOME/data/ax.log"` | `kubectl logs $HOST_POD \| grep -i "automount\|workspace.mount"` |

**Session IDs:**
- Local: `acceptance:workspace:local:it3`
- K8s: `acceptance:workspace:k8s:it3`

**K8s note:** Auto-mount relies on the workspace provider's in-memory scope tracking (`sessionScopes` Map in `shared.ts`). In k8s, the host pod process must survive between turns for this to work. Since we use persistent sessions and the host pod stays running, this should work — but if the host pod restarts between turns, scope memory is lost. This is an expected limitation of the in-memory approach (a future enhancement would persist scope state to the database).

**Pass/Fail:** _pending_

---

## GKE Integration Tests

> Run on **GKE only** — these require a real GCS bucket, k8s sandbox pods (pool controller enabled), and NATS. Cannot run on kind or locally.

### GKE-1: Sandbox tool call triggers GCS user workspace mount, edit, release, and commit

**Criterion:** "Workers cannot write directly to permanent storage. All writes go through the commit pipeline." (Plan §12) + "GCS backend downloads from GCS on mount, uploads on commit" (Plan §9) + "Pod spec always mounts all three paths" (Plan §4)

**Plan references:**
- 2026-03-13-workspace-provider-design.md, §4 (pod compatibility), §5 (host orchestration), §9 (GCS backend), §12 (trust boundary)
- 2026-03-14-sandbox-workspace-permissions.md, Task 3 (k8s pod spec with agent-ws/user-ws volumes)

**What this tests end-to-end:**

This is the production GKE workspace flow. A single user turn exercises the full data path:

```
Agent receives message
  │
  ├─ Host pre-mounts user workspace via GCS backend
  │   └─ GCS backend downloads persisted state into local cache
  │
  ├─ Agent calls a sandbox tool (e.g., bash or write_file)
  │   └─ Triggers NATS sandbox dispatch → claims a warm sandbox pod
  │       └─ Sandbox pod has user-ws emptyDir volume at /workspace/user
  │           └─ Workspace provisioned: GCS content populated into pod volume
  │
  ├─ Agent edits a file in the sandbox at /workspace/user/
  │   └─ edit_file dispatched via NATS to the claimed sandbox pod
  │
  ├─ Turn ends
  │   ├─ NATS "release" message sent to sandbox pod → pod returns to warm pool
  │   └─ Host calls workspace.commit(sessionId)
  │       ├─ GCS backend diffs changes (snapshot comparison)
  │       ├─ Structural checks + scanner run on changed files
  │       └─ Approved changes uploaded to GCS bucket
  │
  └─ GCS bucket now contains the updated file
```

**Prerequisites:**
- GKE cluster with AX deployed
- `sandbox: k8s` with pool controller enabled (warm sandbox pods available)
- `workspace: gcs` with `workspace.bucket` set (or `GCS_WORKSPACE_BUCKET` env var)
- `eventbus: nats`
- GKE Workload Identity or `GOOGLE_APPLICATION_CREDENTIALS` configured for GCS access
- At least one warm sandbox pod in the pool (`tasks.sandbox.light` NATS queue group has subscribers)

**Setup:**
- Config:
  ```yaml
  providers:
    sandbox: k8s
    workspace: gcs
    eventbus: nats
  workspace:
    bucket: $GCS_WORKSPACE_BUCKET
  ```
- Seed the GCS bucket with a known file in the user workspace:
  ```bash
  echo "original content" | gsutil cp - "gs://$GCS_WORKSPACE_BUCKET/user/$TEST_USER_ID/editable.txt"
  ```
- Verify sandbox pool has warm pods:
  ```bash
  kubectl get pods -l app.kubernetes.io/component=sandbox -n $NAMESPACE | grep Running
  ```

**Chat script:**

1. Send (single turn):
   ```
   Use bash to run: echo "updated by sandbox" > /workspace/user/editable.txt
   ```
   **Expected behavior:**
   - Agent uses the `bash` tool (category: `sandbox`)
   - bash tool call triggers NATS sandbox dispatch:
     1. `SandboxClaimRequest` published to `tasks.sandbox.light` queue
     2. Warm pod responds with `SandboxClaimResponse` (podSubject, podId)
     3. `SandboxBashRequest` dispatched to `sandbox.{podId}`
   - Before tool dispatch, workspace provider pre-mounts user scope → GCS backend downloads `editable.txt` from bucket into sandbox pod's `/workspace/user/` directory
   - bash command overwrites the file with new content
   - Turn ends:
     1. `SandboxReleaseRequest` sent via NATS to `sandbox.{podId}` → pod returns to warm pool
     2. `workspace.commit(sessionId)` called by host → GCS backend diffs, detects modified `editable.txt`, uploads to bucket

**Expected outcome:**
- [ ] Agent response confirms bash command executed successfully
- [ ] Audit log contains sandbox bash tool call
- [ ] NATS sandbox dispatch occurred (pod claimed, tool dispatched, pod released)
- [ ] `workspace.commit` event emitted with scope=user, filesChanged≥1
- [ ] GCS bucket at `gs://$GCS_WORKSPACE_BUCKET/user/$TEST_USER_ID/editable.txt` contains "updated by sandbox"
- [ ] No `workspace.commit.rejected` events (file passes structural checks + scanner)
- [ ] No errors in host or sandbox pod logs

**Side-effect checks:**

| Check | Command |
|-------|---------|
| GCS file content | `gsutil cat "gs://$GCS_WORKSPACE_BUCKET/user/$TEST_USER_ID/editable.txt"` — should contain "updated by sandbox" |
| Audit (tool call) | `kubectl exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log WHERE action='bash' ORDER BY timestamp DESC LIMIT 5;"` |
| Audit (commit) | `kubectl exec $PG_POD -- psql -U ax -d ax -c "SELECT * FROM audit_log WHERE action LIKE 'workspace%' ORDER BY timestamp DESC LIMIT 10;"` |
| NATS dispatch logs | `kubectl logs $RUNTIME_POD \| grep -E "pod_claimed\|pod_released\|dispatching_tool"` |
| Workspace commit logs | `kubectl logs $RUNTIME_POD \| grep -E "workspace.commit\|workspace_commit"` |
| Sandbox pod logs | `kubectl logs $SANDBOX_POD \| grep -E "claim\|release\|workspace"` — should show claim, bash execution, release |
| Event bus | `kubectl logs $RUNTIME_POD \| grep "workspace.commit"` — should show event with scope=user |

**Failure modes to watch for:**

| Failure | Symptom | Root cause |
|---------|---------|------------|
| Sandbox pod not claimed | Timeout on bash tool call | Pool controller disabled or no warm pods |
| GCS file not updated | Old content after turn | workspace.commit() not called, or GCS backend diff missed the change |
| File rejected at commit | `workspace.commit.rejected` event | Structural checks or scanner flagged the content |
| Release not sent | Sandbox pod stays claimed | `sandboxDispatcher.release(requestId)` not called in agent-runtime finally block |
| Workspace not pre-mounted | Empty /workspace/user/ in sandbox | GCS backend mount not wiring into sandbox pod volume provisioning |

**Session IDs:**
- GKE: `acceptance:workspace:gke:gke1`

**Pass/Fail:** _pending_

---

## Execution Architecture

```
Lead Agent (you)
├── Shared K8s setup (build image once, load into kind, helm dep update)
├── Feature: workspace
│   ├── Agent: workspace-local
│   │   ├── Setup: isolated TEST_HOME, patch ax.yaml with workspace: local
│   │   ├── Run: ST-1 through ST-9 (structural, source code checks)
│   │   ├── Start server with patched config
│   │   ├── Run: BT-1, BT-2, BT-4, BT-5 (with workspace: local config)
│   │   ├── Restart server with workspace: none for BT-3
│   │   ├── Run: BT-3 (with workspace: none config)
│   │   ├── Restart server with workspace: local for integration tests
│   │   ├── Run: IT-1, IT-2, IT-3 (sequential, shared server)
│   │   ├── Write: tests/acceptance/workspace/results-local.md
│   │   └── Cleanup: kill server, optionally rm TEST_HOME
│   │
│   ├── Agent: workspace-k8s (kind)
│   │   ├── Setup: unique namespace, deploy with workspace: local in config
│   │   ├── Run: BT-1, BT-2, BT-4, BT-5 (with workspace: local config)
│   │   ├── Deploy second namespace with workspace: none for BT-3
│   │   ├── Run: BT-3 (with workspace: none config)
│   │   ├── Tear down BT-3 namespace
│   │   ├── Run: IT-1, IT-2, IT-3 (sequential, same namespace)
│   │   ├── Write: tests/acceptance/workspace/results-k8s.md
│   │   └── Teardown: helm uninstall, delete namespace(s)
│   │
│   └── Agent: workspace-gke (GKE only)
│       ├── Prereqs: GKE cluster, GCS bucket, Workload Identity, pool controller
│       ├── Setup: namespace with workspace: gcs, sandbox: k8s config
│       ├── Seed GCS bucket with test fixture files
│       ├── Verify sandbox warm pool has pods
│       ├── Run: GKE-1 (sandbox→GCS end-to-end)
│       ├── Write: tests/acceptance/workspace/results-gke.md
│       └── Teardown: clean GCS test fixtures, helm uninstall, delete namespace
```

### Config Patching — Local

The local agent must create two config variants:

**Variant A** — `workspace: local` (used by BT-1, BT-2, BT-4, BT-5, IT-1, IT-2, IT-3):
```bash
# After copying fixtures/ax.yaml to $TEST_HOME/ax.yaml, append:
cat >> "$TEST_HOME/ax.yaml" << 'PATCH'

# Workspace provider for acceptance tests
providers:
  workspace: local

workspace:
  basePath: $TEST_HOME/workspaces
PATCH
```

Actually, since `providers:` already exists in the fixture, the agent should use `sed` or a YAML-aware tool to insert `workspace: local` into the existing providers block. Alternatively, the simplest approach: use a heredoc to write a complete ax.yaml that includes `workspace: local`.

**Variant B** — `workspace: none` (used by BT-3):
The original `tests/acceptance/fixtures/ax.yaml` already defaults to no workspace line (which defaults to `none`). Use the unpatched fixture for this test.

**Variant C** — `workspace: local` with `maxFileSize: 100` (used by BT-4):
Same as Variant A but add `maxFileSize: 100` to the workspace section.

### Config Patching — K8s

The k8s agent must create two Helm deployments:

**Deployment A** — `workspace: local` (primary, used by most tests):
Add to kind-values.yaml overrides:
```yaml
config:
  providers:
    workspace: local
  workspace:
    basePath: /home/agent/.ax/workspaces
```

For BT-4, the maxFileSize override can be injected via `--set config.workspace.maxFileSize=100`.

**Deployment B** — `workspace: none` (used only by BT-3):
Separate namespace with no workspace config (or explicit `workspace: none`). Deploy, run BT-3, tear down.

### Config Patching — GKE

The GKE agent requires a real GKE cluster with GCS access. It uses a single deployment:

**Deployment G** — `workspace: gcs`, `sandbox: k8s` (used by GKE-1):
```yaml
config:
  providers:
    sandbox: k8s
    workspace: gcs
    eventbus: nats
  workspace:
    bucket: $GCS_WORKSPACE_BUCKET

# Pool controller must be enabled for sandbox pod warm pool
poolController:
  enabled: true
  pools:
    light:
      min: 1
      max: 4
```

**GCS bucket seeding:**
Before running GKE-1, seed the bucket with a test file:
```bash
echo "original content" | gsutil cp - \
  "gs://$GCS_WORKSPACE_BUCKET/user/$TEST_USER_ID/editable.txt"
```

**GCS bucket cleanup:**
After running GKE-1, remove test fixtures:
```bash
gsutil rm -r "gs://$GCS_WORKSPACE_BUCKET/user/$TEST_USER_ID/"
```
