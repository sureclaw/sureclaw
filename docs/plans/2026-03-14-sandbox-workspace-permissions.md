# Sandbox Workspace Permission Hardening

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `/workspace` root read-only across all sandbox providers, restrict `/workspace/agent` to read-only for non-admin users, and implement k8s workspace tier provisioning via GCS staging.

**Architecture:** Split the single `workspaceMountsWritable` boolean into two flags: `agentWorkspaceWritable` and `userWorkspaceWritable`. The host checks `isAdmin()` before setting `agentWorkspaceWritable=true`. Each sandbox provider enforces `/workspace` root as read-only (only `/workspace/scratch` is writable). The GCS workspace backend gets a transport abstraction — local (bind-mounts) vs remote (k8s NATS staging) — so a single backend serves both modes. K8s pods always declare agent/user workspace volumes; the sandbox worker provisions them from GCS on claim, enforces read-only via chmod, and uploads changes to a GCS staging prefix on release for host-side scanning.

**Tech Stack:** TypeScript, vitest, seatbelt (.sb policy), nsjail, bwrap, Docker, k8s pod specs, GCS, NATS

---

## Summary of Changes

1. **`/workspace` root read-only** — nsjail/bwrap get explicit tmpfs at `/workspace`. Docker and k8s already handle this (`--read-only` / `readOnlyRootFilesystem`). Seatbelt/subprocess use `/tmp` mount roots (ephemeral, no host fs leak).

2. **Per-tier write permissions** — Replace `workspaceMountsWritable: boolean` with `agentWorkspaceWritable` and `userWorkspaceWritable`. Host checks `isAdmin()` for agent tier.

3. **K8s workspace tier provisioning** — Extend claim protocol with scope GCS info. Sandbox worker downloads from GCS, snapshots hashes in memory, enforces read-only via chmod. On release, worker uploads changes to GCS staging prefix. Host reads staging, runs scan pipeline, promotes approved changes.

4. **GCS backend transport abstraction** — Single `gcs.ts` backend with a `WorkspaceTransport` interface: `LocalTransport` (current bind-mount flow) and `RemoteTransport` (k8s NATS staging flow). Backend picks transport based on sandbox provider.

---

## K8s End-to-End Flow

```
1. Host receives message, prepares sandbox config
   |-- Checks isAdmin(agentDir, userId)
   |-- Sets agentWorkspaceWritable = isAdmin && hasWorkspaceProvider
   |-- Sets userWorkspaceWritable = hasWorkspaceProvider
   |-- Builds GCS prefixes: agent/<agentName>/, user/<userId>/

2. Host sends claim via NATS
   +-- { type: 'claim', requestId, sessionId,
         scopes: {
           agent: { gcsPrefix: 'agent/assistant/', readOnly: true },
           user:  { gcsPrefix: 'user/alice/', readOnly: false }
         }}

3. Sandbox worker claims task
   |-- Provisions scratch (existing git clone / GCS cache flow)
   |-- Downloads gs://<bucket>/agent/assistant/** -> /workspace/agent/
   |   |-- Snapshots file hashes in memory
   |   +-- chmod -R a-w /workspace/agent/ (readOnly: true)
   |-- Downloads gs://<bucket>/user/alice/** -> /workspace/user/
   |   +-- Snapshots file hashes in memory (writable, no chmod)
   +-- Returns claim_ack with podSubject

4. Agent executes (tool calls via NATS)
   |-- Can read /workspace/agent/ -- always
   |-- Can't write /workspace/agent/ -- EACCES (non-admin)
   |-- Can read+write /workspace/user/
   +-- Can read+write /workspace/scratch/

5. Host sends release
   +-- Worker:
       |-- Compares /workspace/user/ against in-memory hashes
       |-- Uploads changed files to gs://<bucket>/_staging/<requestId>/user/
       |-- Cleans up, returns to warm pool
       +-- Returns { type: 'release_ack',
             staging: { prefix: '_staging/<requestId>/',
                        scopes: { user: [{path, type, size}] } }}

6. Host commit pipeline
   |-- Reads changed files from GCS staging
   |-- Structural checks + scanner
   |-- Approved -> copy staging -> gs://<bucket>/user/alice/
   |-- Rejected -> delete staging
   +-- Always delete _staging/<requestId>/ when done
```

---

### Task 1: Split `workspaceMountsWritable` into per-tier flags

**Files:**
- Modify: `src/providers/sandbox/types.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write the failing test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
describe('per-tier writable workspace flags', () => {
  test('SandboxConfig has agentWorkspaceWritable and userWorkspaceWritable flags', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/types.ts'), 'utf-8');

    expect(source).toContain('agentWorkspaceWritable');
    expect(source).toContain('userWorkspaceWritable');
    // Old flag should be removed
    expect(source).not.toContain('workspaceMountsWritable');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`
Expected: FAIL -- `workspaceMountsWritable` still exists

**Step 3: Update SandboxConfig**

In `src/providers/sandbox/types.ts`, replace `workspaceMountsWritable` with:

```typescript
  /** When true, /workspace/agent mount is read-write (admin users + workspace provider active). */
  agentWorkspaceWritable?: boolean;
  /** When true, /workspace/user mount is read-write (workspace provider active). */
  userWorkspaceWritable?: boolean;
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 5: Commit**

```bash
git add src/providers/sandbox/types.ts tests/sandbox-isolation.test.ts
git commit -m "refactor: split workspaceMountsWritable into per-tier flags"
```

---

### Task 2: Update host to check isAdmin for agent workspace writes

**Files:**
- Modify: `src/host/server-completions.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write the failing test**

Add to `tests/sandbox-isolation.test.ts`:

```typescript
test('server-completions uses isAdmin for agent workspace permission', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(resolve('src/host/server-completions.ts'), 'utf-8');

  expect(source).toContain('isAdmin');
  expect(source).toContain('agentWorkspaceWritable');
  expect(source).toContain('userWorkspaceWritable');
  expect(source).not.toContain('workspaceMountsWritable');
});
```

**Step 2: Update server-completions.ts**

1. Add import: `import { isAdmin } from './server.js';`

2. Replace the `workspaceMountsWritable` logic (~lines 638-678):

```typescript
    const hasWorkspaceProvider = config.providers.workspace && config.providers.workspace !== 'none';
    let agentWsPath: string | undefined;
    let userWsPath: string | undefined;
    let agentWorkspaceWritable = false;
    let userWorkspaceWritable = false;

    if (hasWorkspaceProvider) {
      try {
        const mountOpts = { userId: currentUserId };
        const preMounted = await providers.workspace.mount(sessionId, ['agent', 'user'], mountOpts);
        agentWsPath = preMounted.paths.agent;
        userWsPath = preMounted.paths.user;
        userWorkspaceWritable = true;
        agentWorkspaceWritable = isAdmin(agentDir(agentName), currentUserId);
        eventBus?.emit({
          type: 'workspace.mount',
          requestId,
          timestamp: Date.now(),
          data: { sessionId, scopes: ['agent', 'user'], agentId: agentName },
        });
      } catch (err) {
        reqLogger.warn('workspace_premount_failed', { error: (err as Error).message });
      }

      // ... remembered scopes logic unchanged

      if (agentWsPath && agentWorkspaceWritable && deps.workspaceMap) {
        deps.workspaceMap.set(requestId, agentWsPath);
      }
    }
```

3. Update the sandboxConfig object:

```typescript
    const sandboxConfig = {
      workspace,
      ipcSocket: ipcSocketPath,
      timeoutSec: config.sandbox.timeout_sec,
      memoryMB: config.sandbox.memory_mb,
      command: spawnCommand,
      agentWorkspace: agentWsPath,
      userWorkspace: userWsPath,
      agentWorkspaceWritable,
      userWorkspaceWritable,
    };
```

**Step 3: Run test**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 4: Commit**

```bash
git add src/host/server-completions.ts tests/sandbox-isolation.test.ts
git commit -m "feat: check isAdmin before granting agent workspace write access"
```

---

### Task 3: Update all sandbox providers to use per-tier flags

**Files:**
- Modify: `src/providers/sandbox/docker.ts`
- Modify: `src/providers/sandbox/nsjail.ts`
- Modify: `src/providers/sandbox/bwrap.ts`
- Modify: `src/providers/sandbox/seatbelt.ts`
- Modify: `src/providers/sandbox/apple.ts`
- Modify: `src/providers/sandbox/subprocess.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Update tests**

Replace the `workspaceMountsWritable` test block in `tests/sandbox-isolation.test.ts`:

```typescript
describe('per-tier writable workspace flags in sandbox providers', () => {
  test('docker uses per-tier writable flags', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    expect(source).toContain("config.agentWorkspaceWritable ? 'rw' : 'ro'");
    expect(source).toContain("config.userWorkspaceWritable ? 'rw' : 'ro'");
    expect(source).not.toContain('workspaceMountsWritable');
  });

  test('bwrap uses per-tier writable flags', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/bwrap.ts'), 'utf-8');
    expect(source).toContain("config.agentWorkspaceWritable ? '--bind' : '--ro-bind'");
    expect(source).toContain("config.userWorkspaceWritable ? '--bind' : '--ro-bind'");
    expect(source).not.toContain('workspaceMountsWritable');
  });

  test('nsjail uses per-tier writable flags', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/nsjail.ts'), 'utf-8');
    expect(source).toContain("config.agentWorkspaceWritable ? '--bindmount' : '--bindmount_ro'");
    expect(source).toContain("config.userWorkspaceWritable ? '--bindmount' : '--bindmount_ro'");
    expect(source).not.toContain('workspaceMountsWritable');
  });

  test('seatbelt uses per-tier writable params', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/seatbelt.ts'), 'utf-8');
    expect(source).toContain('agentWorkspaceWritable');
    expect(source).toContain('userWorkspaceWritable');
    expect(source).not.toContain('workspaceMountsWritable');
  });

  test('apple container uses per-tier writable flags', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/apple.ts'), 'utf-8');
    expect(source).toContain("config.agentWorkspaceWritable ? 'rw' : 'ro'");
    expect(source).toContain("config.userWorkspaceWritable ? 'rw' : 'ro'");
  });

  test('seatbelt policy includes write rules for per-tier RW params', async () => {
    const { readFileSync } = await import('node:fs');
    const policy = readFileSync(resolve('policies/agent.sb'), 'utf-8');
    expect(policy).toContain('(allow file-write* (subpath (param "AGENT_WORKSPACE_RW")))');
    expect(policy).toContain('(allow file-write* (subpath (param "USER_WORKSPACE_RW")))');
  });
});
```

**Step 2: Update each provider**

**docker.ts:**
```typescript
...(config.agentWorkspace ? ['-v', `${config.agentWorkspace}:${CANONICAL.agent}:${config.agentWorkspaceWritable ? 'rw' : 'ro'}`] : []),
...(config.userWorkspace ? ['-v', `${config.userWorkspace}:${CANONICAL.user}:${config.userWorkspaceWritable ? 'rw' : 'ro'}`] : []),
```

**nsjail.ts:**
```typescript
...(config.agentWorkspace ? [config.agentWorkspaceWritable ? '--bindmount' : '--bindmount_ro', `${config.agentWorkspace}:${CANONICAL.agent}`] : []),
...(config.userWorkspace ? [config.userWorkspaceWritable ? '--bindmount' : '--bindmount_ro', `${config.userWorkspace}:${CANONICAL.user}`] : []),
```

**bwrap.ts:**
```typescript
...(config.agentWorkspace ? [config.agentWorkspaceWritable ? '--bind' : '--ro-bind', config.agentWorkspace, CANONICAL.agent] : []),
...(config.userWorkspace ? [config.userWorkspaceWritable ? '--bind' : '--ro-bind', config.userWorkspace, CANONICAL.user] : []),
```

**seatbelt.ts:**
```typescript
'-D', `AGENT_WORKSPACE_RW=${config.agentWorkspaceWritable && config.agentWorkspace ? config.agentWorkspace : '/dev/null'}`,
'-D', `USER_WORKSPACE_RW=${config.userWorkspaceWritable && config.userWorkspace ? config.userWorkspace : '/dev/null'}`,
```

Also remove the unused `-D MOUNT_ROOT` param.

**apple.ts:**
```typescript
...(config.agentWorkspace ? ['-v', `${config.agentWorkspace}:${CANONICAL.agent}:${config.agentWorkspaceWritable ? 'rw' : 'ro'}`] : []),
...(config.userWorkspace ? ['-v', `${config.userWorkspace}:${CANONICAL.user}:${config.userWorkspaceWritable ? 'rw' : 'ro'}`] : []),
```

**Step 3: Run tests**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 4: Commit**

```bash
git add src/providers/sandbox/ policies/agent.sb tests/sandbox-isolation.test.ts
git commit -m "feat: update all sandbox providers to use per-tier writable flags"
```

---

### Task 4: Make `/workspace` root read-only in nsjail and bwrap

**Files:**
- Modify: `src/providers/sandbox/nsjail.ts`
- Modify: `src/providers/sandbox/bwrap.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write tests**

```typescript
describe('/workspace root is read-only', () => {
  test('nsjail creates tmpfs at workspace root', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/nsjail.ts'), 'utf-8');
    expect(source).toContain('--tmpfsmount');
    expect(source).toContain('CANONICAL.root');
  });

  test('bwrap creates tmpfs at workspace root', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/bwrap.ts'), 'utf-8');
    // bwrap --tmpfs creates ephemeral workspace root; /workspace/scratch rw bind overlays on top
    expect(source).toContain("'--tmpfs'");
    expect(source).toContain('CANONICAL.root');
  });

  test('docker already has --read-only flag', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(resolve('src/providers/sandbox/docker.ts'), 'utf-8');
    expect(source).toContain("'--read-only'");
  });
});
```

**Step 2: Update nsjail.ts**

Add before the `--cwd` line:

```typescript
// Read-only workspace root -- /workspace/scratch (rw bind) is the only writable area
'--tmpfsmount', `${CANONICAL.root}:4m`,
```

**Step 3: Update bwrap.ts**

Add before the scratch bind-mount:

```typescript
// Ephemeral workspace root -- /workspace/scratch (rw bind) overlays on top
'--tmpfs', CANONICAL.root,
```

**Step 4: Run tests**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 5: Commit**

```bash
git add src/providers/sandbox/nsjail.ts src/providers/sandbox/bwrap.ts tests/sandbox-isolation.test.ts
git commit -m "feat: make /workspace root read-only in nsjail and bwrap"
```

---

### Task 5: Extend claim protocol with workspace scope info

**Files:**
- Modify: `src/sandbox-worker/types.ts`
- Add test: `tests/sandbox-worker/types.test.ts`

**Step 1: Write test**

```typescript
import { describe, test, expect } from 'vitest';

describe('SandboxClaimRequest workspace scopes', () => {
  test('claim request type includes scopes field', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/sandbox-worker/types.ts', 'utf-8');
    expect(source).toContain('scopes');
    expect(source).toContain('gcsPrefix');
    expect(source).toContain('readOnly');
  });
});
```

**Step 2: Update types**

In `src/sandbox-worker/types.ts`, extend `SandboxClaimRequest`:

```typescript
export interface SandboxClaimRequest {
  type: 'claim';
  requestId: string;
  sessionId: string;
  workspace?: {
    gitUrl?: string;
    ref?: string;
    cacheKey?: string;
  };
  /** Workspace tier provisioning -- download from GCS, enforce permissions. */
  scopes?: {
    agent?: { gcsPrefix: string; readOnly: boolean };
    user?: { gcsPrefix: string; readOnly: boolean };
  };
}
```

Add release response type with staging info:

```typescript
export interface SandboxReleaseResponse {
  type: 'release_ack';
  /** GCS staging info for changed workspace tiers. */
  staging?: {
    prefix: string;
    scopes: {
      agent?: FileMeta[];
      user?: FileMeta[];
    };
  };
}

export interface FileMeta {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  size: number;
}
```

**Step 3: Commit**

```bash
git add src/sandbox-worker/types.ts tests/sandbox-worker/types.test.ts
git commit -m "feat: extend claim protocol with workspace scope provisioning"
```

---

### Task 6: Implement sandbox worker scope provisioning

**Files:**
- Modify: `src/sandbox-worker/workspace.ts`
- Modify: `src/sandbox-worker/worker.ts`
- Add test: `tests/sandbox-worker/workspace.test.ts`

**Step 1: Write tests**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('provisionScope', () => {
  const tmpDir = `/tmp/test-scope-${process.pid}`;

  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('creates mount directory', async () => {
    const { provisionScope } = await import('../../src/sandbox-worker/workspace.js');
    const mountPath = join(tmpDir, 'agent');
    const result = await provisionScope(mountPath, 'agent/test/', true);
    expect(existsSync(mountPath)).toBe(true);
    expect(result.source).toBe('empty'); // no GCS_WORKSPACE_BUCKET set
  });
});

describe('diffScope', () => {
  const tmpDir = `/tmp/test-diff-${process.pid}`;

  beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('detects added files against empty snapshot', async () => {
    const { diffScope } = await import('../../src/sandbox-worker/workspace.js');
    const dir = join(tmpDir, 'scope');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'new.txt'), 'hello');
    const changes = diffScope(dir, new Map());
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('added');
    expect(changes[0].path).toBe('new.txt');
  });
});
```

**Step 2: Add provisionScope and diffScope to workspace.ts**

Note: The sandbox worker already uses `execSync` for gsutil calls (existing pattern
in this file for GCS cache operations). Use `execFileSync` where possible for new
code, but gsutil rsync requires shell glob expansion so `execSync` is acceptable
here with controlled input (GCS prefix is host-constructed, not user input).

```typescript
import { CANONICAL } from '../providers/sandbox/canonical-paths.js';
import type { FileMeta } from './types.js';

const WORKSPACE_BUCKET = process.env.GCS_WORKSPACE_BUCKET ?? '';

export type FileHashMap = Map<string, string>; // relative path -> sha256

export async function provisionScope(
  mountPath: string,
  gcsPrefix: string,
  readOnly: boolean,
): Promise<{ source: 'gcs' | 'empty'; fileCount: number; hashes: FileHashMap }> {
  mkdirSync(mountPath, { recursive: true });
  const hashes: FileHashMap = new Map();

  if (!WORKSPACE_BUCKET) {
    return { source: 'empty', fileCount: 0, hashes };
  }

  try {
    // gsutil rsync needs shell for glob expansion -- input is host-constructed, not user input
    execSync(
      `gsutil -m rsync -r "gs://${WORKSPACE_BUCKET}/${gcsPrefix}" "${mountPath}"`,
      { timeout: 120_000, stdio: 'pipe' },
    );
  } catch {
    return { source: 'empty', fileCount: 0, hashes };
  }

  // Snapshot file hashes for diff on release
  const files = listFilesSync(mountPath);
  for (const relPath of files) {
    const content = readFileSync(join(mountPath, relPath));
    hashes.set(relPath, hashContent(content));
  }

  if (readOnly) {
    execSync(`chmod -R a-w "${mountPath}"`, { stdio: 'pipe' });
  }

  return { source: 'gcs', fileCount: files.length, hashes };
}

export function diffScope(
  mountPath: string,
  baseHashes: FileHashMap,
): FileMeta[] {
  const changes: FileMeta[] = [];
  const currentFiles = listFilesSync(mountPath);
  const currentSet = new Set(currentFiles);

  for (const relPath of currentFiles) {
    const content = readFileSync(join(mountPath, relPath));
    const hash = hashContent(content);
    const oldHash = baseHashes.get(relPath);
    if (!oldHash) {
      changes.push({ path: relPath, type: 'added', size: content.length });
    } else if (hash !== oldHash) {
      changes.push({ path: relPath, type: 'modified', size: content.length });
    }
  }

  for (const relPath of baseHashes.keys()) {
    if (!currentSet.has(relPath)) {
      changes.push({ path: relPath, type: 'deleted', size: 0 });
    }
  }

  return changes;
}

/** Sync helper: list all files recursively under a directory. */
function listFilesSync(baseDir: string, prefix = ''): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesSync(join(baseDir, entry.name), relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
```

**Step 3: Update worker.ts claim handler**

After provisioning scratch, add scope provisioning:

```typescript
import { provisionScope, diffScope, type FileHashMap } from './workspace.js';
import { CANONICAL } from '../providers/sandbox/canonical-paths.js';

// In claim handler, after provisionWorkspace:
const scopeHashes = new Map<string, FileHashMap>();

if (claim.scopes?.agent) {
  const result = await provisionScope(
    CANONICAL.agent, claim.scopes.agent.gcsPrefix, claim.scopes.agent.readOnly,
  );
  if (!claim.scopes.agent.readOnly) scopeHashes.set('agent', result.hashes);
  console.log(`[sandbox-worker] agent scope: source=${result.source}, files=${result.fileCount}`);
}
if (claim.scopes?.user) {
  const result = await provisionScope(
    CANONICAL.user, claim.scopes.user.gcsPrefix, claim.scopes.user.readOnly,
  );
  if (!claim.scopes.user.readOnly) scopeHashes.set('user', result.hashes);
  console.log(`[sandbox-worker] user scope: source=${result.source}, files=${result.fileCount}`);
}
```

**Step 4: Update worker.ts release handler to upload staging and return metadata**

```typescript
import type { SandboxReleaseResponse, FileMeta } from './types.js';

// In release handler, before cleanup:
const STAGING_BUCKET = process.env.GCS_WORKSPACE_BUCKET ?? '';
let staging: SandboxReleaseResponse['staging'];

if (STAGING_BUCKET && scopeHashes.size > 0) {
  const stagingPrefix = `_staging/${claim.requestId}/`;
  const scopeChanges: Partial<Record<string, FileMeta[]>> = {};

  for (const [scope, hashes] of scopeHashes) {
    const mountPath = scope === 'agent' ? CANONICAL.agent : CANONICAL.user;
    const changes = diffScope(mountPath, hashes);
    if (changes.length > 0) {
      // Upload changed files to staging
      for (const change of changes) {
        if (change.type !== 'deleted') {
          const localPath = join(mountPath, change.path);
          const gcsPath = `gs://${STAGING_BUCKET}/${stagingPrefix}${scope}/${change.path}`;
          // gsutil cp with controlled paths (host-constructed prefix + workspace-relative path)
          execSync(`gsutil -q cp "${localPath}" "${gcsPath}"`, { timeout: 30_000, stdio: 'pipe' });
        }
      }
      scopeChanges[scope] = changes;
    }
  }

  if (Object.keys(scopeChanges).length > 0) {
    staging = { prefix: stagingPrefix, scopes: scopeChanges };
  }
}

// Return enriched release_ack
if (toolMsg.reply) {
  toolMsg.respond(encode({ type: 'release_ack', staging }));
}
```

**Step 5: Run tests**

Run: `npm test -- --run tests/sandbox-worker/`

**Step 6: Commit**

```bash
git add src/sandbox-worker/ tests/sandbox-worker/
git commit -m "feat: sandbox worker provisions workspace scopes from GCS"
```

---

### Task 7: Update k8s pod spec with workspace tier volumes

**Files:**
- Modify: `src/providers/sandbox/k8s.ts`
- Modify: `tests/sandbox-isolation.test.ts`

**Step 1: Write test**

```typescript
test('k8s pod spec always declares agent and user workspace volumes', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(resolve('src/providers/sandbox/k8s.ts'), 'utf-8');
  expect(source).toContain("name: 'agent-ws'");
  expect(source).toContain("name: 'user-ws'");
  expect(source).toContain('CANONICAL.agent');
  expect(source).toContain('CANONICAL.user');
});
```

**Step 2: Update buildPodSpec**

Replace the separate `volumeMounts` and `volumes` arrays with a single source of truth:

```typescript
const mounts = [
  { name: 'scratch', mountPath: CANONICAL.scratch, sizeLimit: '1Gi' },
  { name: 'tmp', mountPath: '/tmp', sizeLimit: '64Mi' },
  { name: 'agent-ws', mountPath: CANONICAL.agent, sizeLimit: '1Gi' },
  { name: 'user-ws', mountPath: CANONICAL.user, sizeLimit: '1Gi' },
];

// In the container spec:
volumeMounts: mounts.map(m => ({ name: m.name, mountPath: m.mountPath })),

// In the pod spec:
volumes: mounts.map(m => ({ name: m.name, emptyDir: { sizeLimit: m.sizeLimit } })),
```

**Step 3: Pass scopes in claim request**

Update `nats-sandbox-dispatch.ts` to include scope info in the claim request when
the workspace provider is active. The host builds GCS prefixes from the workspace
config and passes them through.

**Step 4: Run tests**

Run: `npm test -- --run tests/sandbox-isolation.test.ts`

**Step 5: Commit**

```bash
git add src/providers/sandbox/k8s.ts src/host/nats-sandbox-dispatch.ts tests/sandbox-isolation.test.ts
git commit -m "feat: k8s pod spec declares workspace tier volumes, claim includes scopes"
```

---

### Task 8: GCS backend transport abstraction

**Files:**
- Modify: `src/providers/workspace/gcs.ts`
- Add test: `tests/providers/workspace/gcs-transport.test.ts`

**Step 1: Define WorkspaceTransport interface**

```typescript
export interface WorkspaceTransport {
  /** Populate scope directory with GCS content. Returns local path. */
  provision(scope: WorkspaceScope, id: string, gcsPrefix: string): Promise<string>;
  /** Compute changeset since provision. */
  diff(scope: WorkspaceScope, id: string): Promise<FileChange[]>;
  /** Persist approved changes to final GCS prefix. */
  commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void>;
}
```

**Step 2: Extract LocalTransport**

Refactor the existing GCS backend logic into a `LocalTransport` implementing
`WorkspaceTransport`. This is a pure extraction -- no behavior change.

**Step 3: Implement RemoteTransport**

```typescript
function createRemoteTransport(bucket: GcsBucketLike, prefix: string): WorkspaceTransport {
  return {
    async provision() {
      // No-op -- sandbox worker handles provisioning via claim request
      return '';
    },
    async diff(scope, id) {
      // Read staging metadata from NATSSandboxDispatcher release response.
      // The dispatcher stores the staging info after release_ack and exposes
      // it via a getter. The workspace provider reads it here.
      // Download changed files from gs://<bucket>/_staging/<requestId>/<scope>/
      // and return as FileChange[] with content.
    },
    async commit(scope, id, changes) {
      // Copy approved files from staging to final prefix:
      //   gs://<bucket>/_staging/<requestId>/<scope>/<path>
      //   -> gs://<bucket>/<scope>/<id>/<path>
      // Process deletes by removing from final prefix.
      // Clean up staging prefix when done.
    },
  };
}
```

**Step 4: Factory picks transport**

```typescript
export async function create(config: Config): Promise<WorkspaceProvider> {
  const isK8s = config.providers.sandbox === 'k8s';
  const transport = isK8s
    ? createRemoteTransport(bucket, prefix)
    : createLocalTransport(bucket, basePath, prefix);

  const backend: WorkspaceBackend = {
    mount: (scope, id) => transport.provision(scope, id, `${prefix}${scope}/${id}/`),
    diff: (scope, id) => transport.diff(scope, id),
    commit: (scope, id, changes) => transport.commit(scope, id, changes),
  };

  return createOrchestrator({ backend, scanner, config: { ... }, agentId });
}
```

**Step 5: Run tests**

Run: `npm test -- --run tests/providers/workspace/`

**Step 6: Commit**

```bash
git add src/providers/workspace/gcs.ts tests/providers/workspace/
git commit -m "feat: GCS backend transport abstraction for local vs k8s modes"
```

---

### Task 9: Update skill documentation and canonical paths docs

**Files:**
- Modify: `.claude/skills/ax/provider-sandbox/SKILL.md`
- Modify: `src/providers/sandbox/canonical-paths.ts` (update comments)

Update the SandboxConfig interface table:

```markdown
| Field                    | Type       | Notes                                           |
|--------------------------|------------|-------------------------------------------------|
| workspace                | `string`   | Session working directory (rw mount)             |
| ipcSocket                | `string`   | Unix socket path for IPC                         |
| timeoutSec               | `number?`  | Process timeout                                  |
| memoryMB                 | `number?`  | Memory limit                                     |
| command                  | `string[]` | Command + args to execute                        |
| agentWorkspace           | `string?`  | Agent's shared workspace                         |
| userWorkspace            | `string?`  | Per-user persistent storage                      |
| agentWorkspaceWritable   | `boolean?` | rw when admin + workspace provider active        |
| userWorkspaceWritable    | `boolean?` | rw when workspace provider active                |
```

Update the canonical paths table:

```markdown
| Canonical Path       | Mount | Purpose                                      |
|----------------------|-------|----------------------------------------------|
| `/workspace`         | ro    | Mount root (read-only), agent HOME/CWD       |
| `/workspace/scratch` | rw    | Session working files (lost when session ends)|
| `/workspace/agent`   | ro*   | Agent workspace (*rw for admin users only)    |
| `/workspace/user`    | ro*   | Per-user storage (*rw when workspace active)  |
```

**Commit:**

```bash
git add .claude/skills/ax/provider-sandbox/SKILL.md src/providers/sandbox/canonical-paths.ts
git commit -m "docs: update sandbox skill and canonical paths for per-tier permissions"
```

---

### Task 10: Full test suite and final verification

**Step 1:** Run full test suite: `npm test -- --run`
**Step 2:** Fix any remaining references to `workspaceMountsWritable`
**Step 3:** Final commit if needed
