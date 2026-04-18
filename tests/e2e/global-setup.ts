/**
 * Global setup for automated acceptance tests.
 *
 * Creates a kind cluster, builds/loads the Docker image, deploys AX via Helm,
 * starts a mock server on the host, and port-forwards the AX service.
 *
 * Skips cluster creation if AX_SERVER_URL is already set (local mode).
 *
 * Uses execFileSync/spawn (never exec/execSync) per project security policy.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startMockServer, type MockServerInfo } from './mock-server/index.js';

const STATE_DIR = '/tmp/ax-e2e-state';
const STATE_FILE = join(STATE_DIR, 'state.json');

interface SetupState {
  clusterName: string;
  mockServerPort: number;
  portForwardPort: number;
  portForwardPid: number;
  serverUrl: string;
  skippedCluster: boolean;
}

function run(cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string; timeout?: number }): string {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...opts?.env },
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? 300_000, // 5 min default
  }).trim();
}

function runQuiet(cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string; timeout?: number }): void {
  execFileSync(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...opts?.env },
    cwd: opts?.cwd,
    timeout: opts?.timeout ?? 300_000,
  });
}

/** Detect host IP accessible from kind containers. */
function getHostIP(): string {
  // On macOS (Docker Desktop), host.docker.internal is the only reliable way
  // to reach the host from inside kind containers. The Docker bridge gateway
  // (172.x.x.x) is inside the Linux VM and doesn't route to the macOS host.
  if (process.platform === 'darwin') {
    return 'host.docker.internal';
  }
  // On Linux, use the Docker bridge gateway (containers share the host network stack).
  try {
    const output = run('docker', ['network', 'inspect', 'kind', '-f', '{{(index .IPAM.Config 0).Gateway}}']);
    if (output && output !== '<no value>') return output;
  } catch {
    // kind network may not exist yet
  }
  return 'host.docker.internal';
}

/** Wait for a URL to return 200. */
async function waitForHealth(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Health check failed: ${url} did not respond 200 within ${timeoutMs}ms`);
}

/** Find a free port. */
async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function setup(): Promise<void> {
  // Clean up any stale state
  mkdirSync(STATE_DIR, { recursive: true });

  // Skip cluster if AX_SERVER_URL already set.
  // In local mode the caller is responsible for configuring the AX server's
  // OPENROUTER_BASE_URL / STORAGE_EMULATOR_HOST env vars to point at a running
  // mock server. We don't start a mock here because we cannot inject env vars
  // into an externally-managed server process.
  if (process.env.AX_SERVER_URL) {
    console.log(`[setup] AX_SERVER_URL set — skipping kind cluster creation`);
    console.log(`[setup] Using server at ${process.env.AX_SERVER_URL}`);

    const state: SetupState = {
      clusterName: '',
      mockServerPort: 0,
      portForwardPort: 0,
      portForwardPid: 0,
      serverUrl: process.env.AX_SERVER_URL,
      skippedCluster: true,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    // Set env for vitest
    process.env.AX_SERVER_URL = state.serverUrl;
    return;
  }

  const clusterName = `ax-test-${randomBytes(4).toString('hex')}`;
  console.log(`[setup] Creating kind cluster: ${clusterName}`);

  // 1. Start mock server on host (bind 0.0.0.0 so kind containers can reach it)
  const mockInfo = await startMockServer(0);
  console.log(`[setup] Mock server started on port ${mockInfo.port}`);

  // 2. Create kind cluster (must happen before getHostIP so Docker's `kind` network exists)
  console.log(`[setup] Creating kind cluster...`);
  run('kind', ['create', 'cluster', '--name', clusterName, '--wait', '120s']);
  console.log(`[setup] Kind cluster created`);

  // 3. Detect host IP for kind containers (after cluster so Docker bridge network exists)
  const hostIP = getHostIP();
  console.log(`[setup] Host IP for kind containers: ${hostIP}`);
  const mockBaseUrl = `http://${hostIP}:${mockInfo.port}`;

  // 4. Build AX
  console.log(`[setup] Building AX...`);
  run('npm', ['run', 'build']);
  console.log(`[setup] Build complete`);

  // 5. Docker build
  console.log(`[setup] Building Docker image...`);
  run('docker', ['build', '-t', 'ax-test:local', '-f', 'container/agent/Dockerfile', '.']);
  console.log(`[setup] Docker image built`);

  // 6. Load image into kind
  console.log(`[setup] Loading image into kind...`);
  run('kind', ['load', 'docker-image', 'ax-test:local', '--name', clusterName]);
  console.log(`[setup] Image loaded`);

  // 7. Create namespace
  console.log(`[setup] Creating namespace...`);
  try {
    run('kubectl', ['create', 'namespace', 'ax-e2e']);
  } catch {
    // Namespace may already exist
  }

  // 8. Create k8s secret with env vars pointing at mock server
  console.log(`[setup] Creating API credentials secret...`);
  try {
    run('kubectl', ['delete', 'secret', 'ax-api-credentials', '-n', 'ax-e2e']);
  } catch {
    // Secret may not exist yet
  }
  run('kubectl', [
    'create', 'secret', 'generic', 'ax-api-credentials',
    '-n', 'ax-e2e',
    `--from-literal=OPENROUTER_API_KEY=test-openrouter-key`,
    `--from-literal=OPENROUTER_BASE_URL=${mockBaseUrl}/v1`,
    `--from-literal=STORAGE_EMULATOR_HOST=${mockBaseUrl}`,
    `--from-literal=GCS_WORKSPACE_BUCKET=ax-e2e-workspace`,
    `--from-literal=DEEPINFRA_API_KEY=test-deepinfra-key`,
  ]);

  // 9. Helm install
  console.log(`[setup] Deploying AX via Helm...`);
  const valuesPath = join(import.meta.dirname, 'kind-values.yaml');
  run('helm', [
    'upgrade', '--install', 'ax', './charts/ax',
    '-n', 'ax-e2e',
    '-f', valuesPath,
    '--set', `global.imageTag=local`,
    '--set', `global.imageRepository=ax-test`,
    '--set', `config.url_rewrites.mock-target\\.test=${mockBaseUrl}`,
    '--set', `config.url_rewrites.api\\.linear\\.app=${mockBaseUrl}`,
    '--wait',
    '--timeout', '300s',
  ], { timeout: 600_000 }); // 10 min — Helm --wait needs time for init jobs + pod readiness
  console.log(`[setup] Helm deployment complete`);

  // 10. Wait for rollout
  console.log(`[setup] Waiting for rollout...`);
  run('kubectl', ['rollout', 'status', 'deployment/ax-host', '-n', 'ax-e2e', '--timeout=300s'], { timeout: 600_000 });

  // 11. Port-forward
  const localPort = await findFreePort();
  console.log(`[setup] Port-forwarding to localhost:${localPort}...`);
  const pf = spawn('kubectl', [
    'port-forward', 'svc/ax-host', `${localPort}:80`, '-n', 'ax-e2e',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  pf.unref();

  // Give port-forward a moment to establish
  await new Promise(r => setTimeout(r, 3000));

  const serverUrl = `http://127.0.0.1:${localPort}`;

  // 12. Save state
  const state: SetupState = {
    clusterName,
    mockServerPort: mockInfo.port,
    portForwardPort: localPort,
    portForwardPid: pf.pid!,
    serverUrl,
    skippedCluster: false,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // 13. Set env for vitest
  process.env.AX_SERVER_URL = serverUrl;
  process.env.MOCK_SERVER_PORT = String(mockInfo.port);

  // 14. Wait for health
  console.log(`[setup] Waiting for server health...`);
  await waitForHealth(`${serverUrl}/health`, 180_000);
  console.log(`[setup] Server healthy at ${serverUrl}`);
}

export async function teardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    console.log(`[teardown] No state file found — nothing to clean up`);
    return;
  }

  const state: SetupState = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  console.log(`[teardown] Cleaning up...`);

  // Kill port-forward
  if (state.portForwardPid) {
    try {
      process.kill(state.portForwardPid, 'SIGTERM');
      console.log(`[teardown] Port-forward killed`);
    } catch {
      // Process may have already exited
    }
  }

  // Delete kind cluster
  if (!state.skippedCluster && state.clusterName) {
    try {
      console.log(`[teardown] Deleting kind cluster: ${state.clusterName}`);
      run('kind', ['delete', 'cluster', '--name', state.clusterName]);
      console.log(`[teardown] Kind cluster deleted`);
    } catch (err) {
      console.error(`[teardown] Failed to delete cluster: ${err}`);
    }
  }

  // Clean up state files
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  // Clean up GCS temp files
  try {
    rmSync('/tmp/fake-gcs', { recursive: true, force: true });
  } catch {
    // Ignore
  }

  console.log(`[teardown] Done`);
}
