# GCP Secret Manager Credential Provider

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `gcp-secret-manager` credential provider that retrieves secrets from Google Cloud Secret Manager, authenticated via GKE Workload Identity (no credentials needed in the pod).

**Architecture:** A new credential provider at `src/providers/credentials/gcp-secret-manager.ts` implementing the standard `CredentialProvider` interface. Uses the `@google-cloud/secret-manager` SDK, which automatically picks up Application Default Credentials (ADC) — on GKE with Workload Identity, this means zero-config auth. Falls back to the `encrypted` provider if the SDK is unavailable or GCP auth fails, following the same pattern as the `keychain` provider.

**Tech Stack:** `@google-cloud/secret-manager` (Google Cloud client library), Workload Identity Federation (GKE), Application Default Credentials (ADC)

---

## Design Decisions

### Secret naming convention
GCP Secret Manager secret IDs must match `[a-zA-Z0-9_-]+`. AX service names (e.g. `ANTHROPIC_API_KEY`) already fit this pattern. The provider will use service names as-is for secret IDs, with an optional configurable prefix (env var `AX_GCP_SECRET_PREFIX`, default: `ax-`) to namespace AX secrets within a shared GCP project.

### Secret versions
Always access `latest` version. Secret Manager handles versioning internally — we don't need to track versions.

### GCP Project ID
Read from `AX_GCP_PROJECT_ID` env var. If not set, the SDK's auto-detection picks up the project from ADC/metadata server (works on GKE automatically).

### Graceful fallback
If `@google-cloud/secret-manager` is not installed or GCP auth fails at create-time, fall back to `encrypted` provider with a warning — same pattern as `keychain.ts`.

### Write support
`set()` and `delete()` are supported. `set()` creates the secret if it doesn't exist, or adds a new version if it does. `delete()` deletes the secret entirely.

---

## Task 1: Install dependency

**Files:**
- Modify: `package.json`

**Step 1: Add the GCP Secret Manager client library**

Run:
```bash
npm install @google-cloud/secret-manager
```

**Step 2: Verify installation**

Run:
```bash
node -e "require('@google-cloud/secret-manager'); console.log('ok')"
```
Expected: `ok`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @google-cloud/secret-manager dependency"
```

---

## Task 2: Write failing tests for the GCP Secret Manager provider

**Files:**
- Create: `tests/providers/credentials/gcp-secret-manager.test.ts`

**Step 1: Write the test file**

This test file mocks the GCP SDK so tests run without real GCP credentials. Tests cover: CRUD operations, fallback when SDK unavailable, prefix behavior, project ID resolution, and error handling.

```typescript
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

// In-memory store simulating GCP Secret Manager
let secretStore: Map<string, string>;

// Mock the @google-cloud/secret-manager module
vi.mock('@google-cloud/secret-manager', () => {
  class SecretManagerServiceClient {
    private projectId: string;

    constructor(opts?: { projectId?: string }) {
      this.projectId = opts?.projectId ?? 'auto-detected-project';
    }

    async accessSecretVersion(req: { name: string }): Promise<[{ payload: { data: Buffer } }]> {
      // Parse secret ID from the full resource name
      // Format: projects/PROJECT/secrets/SECRET_ID/versions/latest
      const parts = req.name.split('/');
      const secretId = parts[3];

      if (!secretStore.has(secretId)) {
        const err = new Error(`Secret ${secretId} not found`) as Error & { code: number };
        err.code = 5; // gRPC NOT_FOUND
        throw err;
      }

      return [{ payload: { data: Buffer.from(secretStore.get(secretId)!) } }];
    }

    async createSecret(req: {
      parent: string;
      secretId: string;
      secret: { replication: { automatic: Record<string, never> } };
    }): Promise<[unknown]> {
      // Secret creation (no-op for store; value is set via addSecretVersion)
      return [{}];
    }

    async addSecretVersion(req: {
      parent: string;
      payload: { data: Buffer };
    }): Promise<[unknown]> {
      // Parse secret ID from parent: projects/PROJECT/secrets/SECRET_ID
      const parts = req.parent.split('/');
      const secretId = parts[3];
      secretStore.set(secretId, req.payload.data.toString('utf-8'));
      return [{}];
    }

    async deleteSecret(req: { name: string }): Promise<void> {
      const parts = req.name.split('/');
      const secretId = parts[3];
      secretStore.delete(secretId);
    }

    async listSecrets(req: {
      parent: string;
    }): Promise<[Array<{ name: string }>]> {
      const prefix = `projects/${this.projectId}/secrets/`;
      const secrets = [...secretStore.keys()].map(id => ({
        name: `${prefix}${id}`,
      }));
      return [secrets];
    }

    async getProjectId(): Promise<string> {
      return this.projectId;
    }
  }

  return { SecretManagerServiceClient };
});

describe('creds-gcp-secret-manager', () => {
  let creds: CredentialProvider;
  const originalProjectId = process.env.AX_GCP_PROJECT_ID;
  const originalPrefix = process.env.AX_GCP_SECRET_PREFIX;

  beforeEach(async () => {
    secretStore = new Map();
    process.env.AX_GCP_PROJECT_ID = 'test-project-123';
    delete process.env.AX_GCP_SECRET_PREFIX;

    const { create } = await import(
      '../../../src/providers/credentials/gcp-secret-manager.js'
    );
    creds = await create(config);
  });

  afterEach(() => {
    if (originalProjectId !== undefined) {
      process.env.AX_GCP_PROJECT_ID = originalProjectId;
    } else {
      delete process.env.AX_GCP_PROJECT_ID;
    }
    if (originalPrefix !== undefined) {
      process.env.AX_GCP_SECRET_PREFIX = originalPrefix;
    } else {
      delete process.env.AX_GCP_SECRET_PREFIX;
    }
    vi.restoreAllMocks();
  });

  test('set and get a credential', async () => {
    await creds.set('ANTHROPIC_API_KEY', 'sk-ant-test-123');
    const value = await creds.get('ANTHROPIC_API_KEY');
    expect(value).toBe('sk-ant-test-123');
  });

  test('returns null for non-existent credential', async () => {
    const value = await creds.get('NONEXISTENT');
    expect(value).toBeNull();
  });

  test('delete removes a credential', async () => {
    await creds.set('TO_DELETE', 'value');
    await creds.delete('TO_DELETE');
    const value = await creds.get('TO_DELETE');
    expect(value).toBeNull();
  });

  test('list returns all credential keys', async () => {
    await creds.set('KEY_A', 'a');
    await creds.set('KEY_B', 'b');
    const keys = await creds.list();
    expect(keys).toContain('KEY_A');
    expect(keys).toContain('KEY_B');
  });

  test('uses custom prefix when AX_GCP_SECRET_PREFIX is set', async () => {
    process.env.AX_GCP_SECRET_PREFIX = 'myapp-';
    const { create } = await import(
      '../../../src/providers/credentials/gcp-secret-manager.js'
    );
    const prefixed = await create(config);
    await prefixed.set('MY_KEY', 'my-value');

    // Verify the secret was stored with prefix in the backing store
    expect(secretStore.has('myapp-MY_KEY')).toBe(true);

    // Verify retrieval strips the prefix
    const value = await prefixed.get('MY_KEY');
    expect(value).toBe('my-value');
  });

  test('uses default ax- prefix', async () => {
    await creds.set('KEY', 'val');
    expect(secretStore.has('ax-KEY')).toBe(true);
  });

  test('list strips prefix from returned keys', async () => {
    await creds.set('KEY_A', 'a');
    await creds.set('KEY_B', 'b');
    const keys = await creds.list();
    expect(keys).not.toContain('ax-KEY_A');
    expect(keys).toContain('KEY_A');
    expect(keys).toContain('KEY_B');
  });

  test('delete is idempotent for non-existent secrets', async () => {
    // Should not throw
    await expect(creds.delete('DOES_NOT_EXIST')).resolves.toBeUndefined();
  });

  test('set overwrites existing credential', async () => {
    await creds.set('KEY', 'original');
    await creds.set('KEY', 'updated');
    const value = await creds.get('KEY');
    expect(value).toBe('updated');
  });
});

describe('creds-gcp-secret-manager fallback', () => {
  test('falls back to encrypted provider when SDK unavailable', async () => {
    // This test verifies fallback behavior. The actual fallback
    // is triggered by import failure of @google-cloud/secret-manager.
    // Since we mock the module above, we test fallback by simulating
    // a constructor error.
    vi.doMock('@google-cloud/secret-manager', () => {
      class SecretManagerServiceClient {
        constructor() {
          throw new Error('Could not load the default credentials');
        }
      }
      return { SecretManagerServiceClient };
    });

    // Need to set up encrypted provider fallback env
    const { mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');

    const testDir = join(tmpdir(), `ax-gcp-fallback-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.AX_CREDS_STORE_PATH = join(testDir, 'credentials.enc');
    process.env.AX_CREDS_PASSPHRASE = 'test-passphrase';

    const { create } = await import(
      '../../../src/providers/credentials/gcp-secret-manager.js'
    );
    const fallback = await create({} as Config);

    // Should work as encrypted provider
    await fallback.set('FALLBACK_KEY', 'fallback-value');
    expect(await fallback.get('FALLBACK_KEY')).toBe('fallback-value');

    // Cleanup
    const { rmSync } = await import('node:fs');
    try { rmSync(testDir, { recursive: true }); } catch {}
    delete process.env.AX_CREDS_STORE_PATH;
    delete process.env.AX_CREDS_PASSPHRASE;
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- --run tests/providers/credentials/gcp-secret-manager.test.ts
```
Expected: FAIL — module `../../../src/providers/credentials/gcp-secret-manager.js` does not exist.

**Step 3: Commit**

```bash
git add tests/providers/credentials/gcp-secret-manager.test.ts
git commit -m "test: add failing tests for GCP Secret Manager credential provider"
```

---

## Task 3: Implement the GCP Secret Manager provider

**Files:**
- Create: `src/providers/credentials/gcp-secret-manager.ts`

**Step 1: Write the provider implementation**

```typescript
import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';

/**
 * GCP Secret Manager credential provider.
 *
 * Stores and retrieves secrets from Google Cloud Secret Manager.
 * Authenticates via Application Default Credentials (ADC):
 * - On GKE with Workload Identity: automatic, zero-config
 * - Locally: uses `gcloud auth application-default login`
 * - CI: use GOOGLE_APPLICATION_CREDENTIALS env var
 *
 * Configuration:
 *   AX_GCP_PROJECT_ID     — GCP project ID (auto-detected on GKE if not set)
 *   AX_GCP_SECRET_PREFIX   — Prefix for secret names (default: "ax-")
 *
 * Falls back to encrypted provider if SDK is unavailable or auth fails.
 */
export async function create(config: Config): Promise<CredentialProvider> {
  const prefix = process.env.AX_GCP_SECRET_PREFIX ?? 'ax-';

  let client: InstanceType<typeof import('@google-cloud/secret-manager').SecretManagerServiceClient>;
  let projectId: string;

  try {
    const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
    const explicitProject = process.env.AX_GCP_PROJECT_ID;
    client = new SecretManagerServiceClient(
      explicitProject ? { projectId: explicitProject } : undefined,
    );
    projectId = explicitProject ?? await client.getProjectId();
  } catch {
    const { getLogger } = await import('../../logger.js');
    getLogger().warn('gcp_secret_manager_unavailable', {
      message:
        'GCP Secret Manager unavailable (SDK not installed or auth failed). ' +
        'Falling back to encrypted file provider.',
      suggestion:
        'Install the SDK: npm install @google-cloud/secret-manager — ' +
        'or configure Workload Identity on GKE.',
    });
    const { create: createEncrypted } = await import('./encrypted.js');
    return createEncrypted(config);
  }

  function secretPath(service: string): string {
    return `projects/${projectId}/secrets/${prefix}${service}`;
  }

  function versionPath(service: string): string {
    return `${secretPath(service)}/versions/latest`;
  }

  return {
    async get(service: string): Promise<string | null> {
      try {
        const [version] = await client.accessSecretVersion({
          name: versionPath(service),
        });
        const payload = version.payload?.data;
        if (!payload) return null;
        return typeof payload === 'string'
          ? payload
          : Buffer.from(payload).toString('utf-8');
      } catch (err: unknown) {
        // gRPC NOT_FOUND (code 5) means secret doesn't exist
        if (err && typeof err === 'object' && 'code' in err && err.code === 5) {
          return null;
        }
        throw err;
      }
    },

    async set(service: string, value: string): Promise<void> {
      // Try to create the secret first; if it already exists, just add a version
      try {
        await client.createSecret({
          parent: `projects/${projectId}`,
          secretId: `${prefix}${service}`,
          secret: { replication: { automatic: {} } },
        });
      } catch (err: unknown) {
        // gRPC ALREADY_EXISTS (code 6) is fine — secret exists, we'll add a version
        if (!(err && typeof err === 'object' && 'code' in err && err.code === 6)) {
          throw err;
        }
      }

      await client.addSecretVersion({
        parent: secretPath(service),
        payload: { data: Buffer.from(value, 'utf-8') },
      });
    },

    async delete(service: string): Promise<void> {
      try {
        await client.deleteSecret({ name: secretPath(service) });
      } catch (err: unknown) {
        // gRPC NOT_FOUND — already gone, that's fine
        if (!(err && typeof err === 'object' && 'code' in err && err.code === 5)) {
          throw err;
        }
      }
    },

    async list(): Promise<string[]> {
      const [secrets] = await client.listSecrets({
        parent: `projects/${projectId}`,
      });
      return secrets
        .map(s => {
          const name = s.name ?? '';
          // Extract secret ID from full resource name, then strip prefix
          const id = name.split('/').pop() ?? '';
          return id.startsWith(prefix) ? id.slice(prefix.length) : null;
        })
        .filter((s): s is string => s !== null);
    },
  };
}
```

**Step 2: Run the tests**

Run:
```bash
npm test -- --run tests/providers/credentials/gcp-secret-manager.test.ts
```
Expected: All tests PASS.

**Step 3: Commit**

```bash
git add src/providers/credentials/gcp-secret-manager.ts
git commit -m "feat: add GCP Secret Manager credential provider"
```

---

## Task 4: Register the provider in the static allowlist

**Files:**
- Modify: `src/host/provider-map.ts:58-62`

**Step 1: Write a failing test**

There's no dedicated test for provider-map registration, but we can verify the type system picks it up. The real test is: after adding the entry, `CredentialProviderName` includes `'gcp-secret-manager'`, and `resolveProviderPath('credentials', 'gcp-secret-manager')` returns a valid path.

Create a small integration check:

Create file `tests/providers/credentials/gcp-registration.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import { resolveProviderPath, PROVIDER_MAP } from '../../../src/host/provider-map.js';

describe('gcp-secret-manager registration', () => {
  test('is registered in PROVIDER_MAP', () => {
    expect(PROVIDER_MAP.credentials).toHaveProperty('gcp-secret-manager');
  });

  test('resolveProviderPath returns a file:// URL', () => {
    const path = resolveProviderPath('credentials', 'gcp-secret-manager');
    expect(path).toMatch(/^file:\/\//);
    expect(path).toContain('gcp-secret-manager');
  });
});
```

**Step 2: Run to verify it fails**

Run:
```bash
npm test -- --run tests/providers/credentials/gcp-registration.test.ts
```
Expected: FAIL — `gcp-secret-manager` not in PROVIDER_MAP.

**Step 3: Add the entry to provider-map.ts**

In `src/host/provider-map.ts`, inside the `credentials` block (line 58-62), add the new entry:

```typescript
  credentials: {
    env:                  '../providers/credentials/env.js',
    encrypted:            '../providers/credentials/encrypted.js',
    keychain:             '../providers/credentials/keychain.js',
    'gcp-secret-manager': '../providers/credentials/gcp-secret-manager.js',
  },
```

**Step 4: Run the registration test**

Run:
```bash
npm test -- --run tests/providers/credentials/gcp-registration.test.ts
```
Expected: PASS.

**Step 5: Run the full test suite to check for regressions**

Run:
```bash
npm test -- --run
```
Expected: All tests PASS. TypeScript should compile cleanly because `CredentialProviderName` is derived from the `_PROVIDER_MAP` type.

**Step 6: Commit**

```bash
git add src/host/provider-map.ts tests/providers/credentials/gcp-registration.test.ts
git commit -m "feat: register gcp-secret-manager in provider allowlist"
```

---

## Task 5: Build verification and final commit

**Step 1: Run TypeScript compilation**

Run:
```bash
npm run build
```
Expected: Clean compilation, no errors.

**Step 2: Run the full test suite**

Run:
```bash
npm test -- --run
```
Expected: All tests PASS.

**Step 3: Verify config accepts the new provider name**

The config schema uses `providerEnum('credentials')` which reads keys from `PROVIDER_MAP.credentials` at runtime. No code change needed — it automatically includes `gcp-secret-manager` since we added it to the map. Verify by checking that a config YAML with `credentials: gcp-secret-manager` would pass validation (this happens automatically via the Zod enum).

---

## Usage

After implementation, users configure AX for GKE by setting in `ax.yaml`:

```yaml
providers:
  credentials: gcp-secret-manager
```

And optionally:

```bash
# Only needed if auto-detection doesn't work (always works on GKE)
export AX_GCP_PROJECT_ID=my-project-id

# Custom prefix (default: "ax-")
export AX_GCP_SECRET_PREFIX=prod-ax-
```

On GKE with Workload Identity: zero additional config. The pod's Kubernetes Service Account is bound to a GCP IAM Service Account with `roles/secretmanager.secretAccessor`, and the SDK handles the rest.

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Install `@google-cloud/secret-manager` | `package.json` |
| 2 | Write failing tests | `tests/providers/credentials/gcp-secret-manager.test.ts` |
| 3 | Implement the provider | `src/providers/credentials/gcp-secret-manager.ts` |
| 4 | Register in provider-map | `src/host/provider-map.ts`, `tests/providers/credentials/gcp-registration.test.ts` |
| 5 | Build verification | No new files |
