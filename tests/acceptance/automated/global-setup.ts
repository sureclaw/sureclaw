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

const STATE_DIR = '/tmp/ax-acceptance-state';
const STATE_FILE = join(STATE_DIR, 'state.json');

interface SetupState {
  clusterName: string;
  mockServerPort: number;
  portForwardPort: number;
  portForwardPid: number;
  serverUrl: string;
  skippedCluster: boolean;
}

function run(cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string }): string {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...opts?.env },
    cwd: opts?.cwd,
    timeout: 300_000, // 5 min max per command
  }).trim();
}

function runQuiet(cmd: string, args: string[], opts?: { env?: Record<string, string>; cwd?: string }): void {
  execFileSync(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...opts?.env },
    cwd: opts?.cwd,
    timeout: 300_000,
  });
}

/** Detect host IP accessible from kind containers (Docker bridge gateway). */
function getHostIP(): string {
  try {
    const output = run('docker', ['network', 'inspect', 'kind', '-f', '{{(index .IPAM.Config 0).Gateway}}']);
    if (output && output !== '<no value>') return output;
  } catch {
    // kind network may not exist yet
  }
  // Fallback: use host.docker.internal on macOS
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
function findFreePort(): number {
  const { createServer } = require('node:net');
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  const port = srv.address().port;
  srv.close();
  return port;
}

export async function setup(): Promise<void> {
  // Clean up any stale state
  mkdirSync(STATE_DIR, { recursive: true });

  // Skip cluster if AX_SERVER_URL already set
  if (process.env.AX_SERVER_URL) {
    console.log(`[setup] AX_SERVER_URL set — skipping kind cluster creation`);
    console.log(`[setup] Using server at ${process.env.AX_SERVER_URL}`);

    // Start mock server even in local mode
    const mockInfo = await startMockServer(0);
    console.log(`[setup] Mock server started on port ${mockInfo.port}`);

    const state: SetupState = {
      clusterName: '',
      mockServerPort: mockInfo.port,
      portForwardPort: 0,
      portForwardPid: 0,
      serverUrl: process.env.AX_SERVER_URL,
      skippedCluster: true,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    // Set env for vitest
    process.env.AX_SERVER_URL = state.serverUrl;
    process.env.MOCK_SERVER_PORT = String(state.mockServerPort);
    return;
  }

  const clusterName = `ax-test-${randomBytes(4).toString('hex')}`;
  console.log(`[setup] Creating kind cluster: ${clusterName}`);

  // 1. Start mock server on host (bind 0.0.0.0 so kind containers can reach it)
  const mockInfo = await startMockServer(0);
  console.log(`[setup] Mock server started on port ${mockInfo.port}`);

  // 2. Detect host IP for kind containers
  const hostIP = getHostIP();
  console.log(`[setup] Host IP for kind containers: ${hostIP}`);
  const mockBaseUrl = `http://${hostIP}:${mockInfo.port}`;

  // 3. Create kind cluster
  console.log(`[setup] Creating kind cluster...`);
  run('kind', ['create', 'cluster', '--name', clusterName, '--wait', '120s']);
  console.log(`[setup] Kind cluster created`);

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
    run('kubectl', ['create', 'namespace', 'ax-acceptance']);
  } catch {
    // Namespace may already exist
  }

  // 8. Create k8s secret with env vars pointing at mock server
  console.log(`[setup] Creating API credentials secret...`);
  try {
    run('kubectl', ['delete', 'secret', 'ax-api-credentials', '-n', 'ax-acceptance']);
  } catch {
    // Secret may not exist yet
  }
  run('kubectl', [
    'create', 'secret', 'generic', 'ax-api-credentials',
    '-n', 'ax-acceptance',
    `--from-literal=OPENROUTER_API_KEY=test-openrouter-key`,
    `--from-literal=OPENROUTER_BASE_URL=${mockBaseUrl}/v1`,
    `--from-literal=STORAGE_EMULATOR_HOST=${mockBaseUrl}`,
    `--from-literal=GCS_WORKSPACE_BUCKET=ax-acceptance-workspace`,
    `--from-literal=CLAWHUB_API_URL=${mockBaseUrl}/clawhub/api/v1`,
    `--from-literal=DEEPINFRA_API_KEY=test-deepinfra-key`,
  ]);

  // 9. Helm install
  console.log(`[setup] Deploying AX via Helm...`);
  const valuesPath = join(import.meta.dirname, 'kind-values.yaml');
  run('helm', [
    'upgrade', '--install', 'ax', './charts/ax',
    '-n', 'ax-acceptance',
    '-f', valuesPath,
    '--set', `global.imageTag=local`,
    '--set', `global.imageRepository=ax-test`,
    '--wait',
    '--timeout', '180s',
  ]);
  console.log(`[setup] Helm deployment complete`);

  // 10. Wait for rollout
  console.log(`[setup] Waiting for rollout...`);
  run('kubectl', ['rollout', 'status', 'deployment/ax-host', '-n', 'ax-acceptance', '--timeout=180s']);

  // 11. Port-forward
  const localPort = findFreePort();
  console.log(`[setup] Port-forwarding to localhost:${localPort}...`);
  const pf = spawn('kubectl', [
    'port-forward', 'svc/ax-host', `${localPort}:8080`, '-n', 'ax-acceptance',
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
  await waitForHealth(`${serverUrl}/health`, 60_000);
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
