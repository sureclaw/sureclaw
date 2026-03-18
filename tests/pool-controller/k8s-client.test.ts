// tests/pool-controller/k8s-client.test.ts — Tests for pool controller pod creation
//
// Verifies that warm pool pods are created with the correct env vars,
// including NATS credentials for sandbox authentication.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @kubernetes/client-node
const mockCreateNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockDeleteNamespacedPod = vi.fn().mockResolvedValue({ body: {} });
const mockListNamespacedPod = vi.fn().mockResolvedValue({ items: [] });
const mockPatchNamespacedPod = vi.fn().mockResolvedValue({ body: {} });

class MockKubeConfig {
  loadFromCluster() { throw new Error('not in cluster'); }
  loadFromDefault() {}
  makeApiClient() {
    return {
      createNamespacedPod: mockCreateNamespacedPod,
      deleteNamespacedPod: mockDeleteNamespacedPod,
      listNamespacedPod: mockListNamespacedPod,
      patchNamespacedPod: mockPatchNamespacedPod,
    };
  }
}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: class {},
}));

import { createPoolK8sClient, type PodTemplate } from '../../src/pool-controller/k8s-client.js';

function basePodTemplate(): PodTemplate {
  return {
    image: 'ax/agent:latest',
    command: ['node', '/opt/ax/dist/agent/runner.js', '--agent', 'pi-coding-agent'],
    cpu: '1',
    memory: '512Mi',
    tier: 'light',
    natsUrl: 'nats://nats:4222',
    workspaceRoot: '/workspace',
  };
}

describe('pool-controller k8s-client createPod', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNamespacedPod.mockResolvedValue({ body: {} });
    // Save env vars we'll modify
    savedEnv.NATS_SANDBOX_PASS = process.env.NATS_SANDBOX_PASS;
    savedEnv.K8S_NAMESPACE = process.env.K8S_NAMESPACE;
    savedEnv.K8S_IMAGE_PULL_POLICY = process.env.K8S_IMAGE_PULL_POLICY;
    savedEnv.K8S_IMAGE_PULL_SECRETS = process.env.K8S_IMAGE_PULL_SECRETS;
    savedEnv.AX_VERBOSE = process.env.AX_VERBOSE;
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  test('createPod includes NATS_USER=sandbox and NATS_PASS when NATS_SANDBOX_PASS is set', async () => {
    // This test reproduces the NATS 503 bug: if NATS_SANDBOX_PASS is not in the
    // pool controller's env, warm pods are created without NATS credentials.
    // They connect anonymously, and the NATS server rejects their publishes → 503.
    process.env.NATS_SANDBOX_PASS = 'test-sandbox-secret';

    const client = await createPoolK8sClient('ax');
    await client.createPod(basePodTemplate());

    const body = mockCreateNamespacedPod.mock.calls[0][0].body;
    const env = body.spec.containers[0].env;

    const natsUser = env.find((e: any) => e.name === 'NATS_USER');
    const natsPass = env.find((e: any) => e.name === 'NATS_PASS');

    expect(natsUser).toEqual({ name: 'NATS_USER', value: 'sandbox' });
    expect(natsPass).toEqual({ name: 'NATS_PASS', value: 'test-sandbox-secret' });
  });

  test('createPod omits NATS credentials when NATS_SANDBOX_PASS is not set', async () => {
    delete process.env.NATS_SANDBOX_PASS;

    const client = await createPoolK8sClient('ax');
    await client.createPod(basePodTemplate());

    const body = mockCreateNamespacedPod.mock.calls[0][0].body;
    const env = body.spec.containers[0].env;

    const natsUser = env.find((e: any) => e.name === 'NATS_USER');
    const natsPass = env.find((e: any) => e.name === 'NATS_PASS');

    expect(natsUser).toBeUndefined();
    expect(natsPass).toBeUndefined();
  });

  test('createPod sets AX_IPC_TRANSPORT=http', async () => {
    delete process.env.NATS_SANDBOX_PASS;

    const client = await createPoolK8sClient('ax');
    await client.createPod(basePodTemplate());

    const body = mockCreateNamespacedPod.mock.calls[0][0].body;
    const env = body.spec.containers[0].env;

    const transport = env.find((e: any) => e.name === 'AX_IPC_TRANSPORT');
    expect(transport).toEqual({ name: 'AX_IPC_TRANSPORT', value: 'http' });
  });

  test('createPod sets NATS_URL from template', async () => {
    const client = await createPoolK8sClient('ax');
    const template = { ...basePodTemplate(), natsUrl: 'nats://custom:4222' };
    await client.createPod(template);

    const body = mockCreateNamespacedPod.mock.calls[0][0].body;
    const env = body.spec.containers[0].env;

    const natsUrl = env.find((e: any) => e.name === 'NATS_URL');
    expect(natsUrl).toEqual({ name: 'NATS_URL', value: 'nats://custom:4222' });
  });

  test('createPod sets POD_NAME from downward API', async () => {
    const client = await createPoolK8sClient('ax');
    await client.createPod(basePodTemplate());

    const body = mockCreateNamespacedPod.mock.calls[0][0].body;
    const env = body.spec.containers[0].env;

    const podName = env.find((e: any) => e.name === 'POD_NAME');
    expect(podName).toEqual({
      name: 'POD_NAME',
      valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
    });
  });

  test('createPod includes extraVolumes and extraVolumeMounts when provided', async () => {
    delete process.env.NATS_SANDBOX_PASS;

    const client = await createPoolK8sClient('ax');
    const template: PodTemplate = {
      ...basePodTemplate(),
      extraVolumes: [
        { name: 'ax-dev-dist', hostPath: { path: '/ax-dev/dist' } },
      ],
      extraVolumeMounts: [
        { name: 'ax-dev-dist', mountPath: '/opt/ax/dist' },
      ],
    };
    await client.createPod(template);

    const body = mockCreateNamespacedPod.mock.calls[0][0].body;
    const volumes = body.spec.volumes;
    const mounts = body.spec.containers[0].volumeMounts;

    // Should include the 4 default volumes + 1 extra
    expect(volumes).toHaveLength(5);
    expect(volumes[4]).toEqual({ name: 'ax-dev-dist', hostPath: { path: '/ax-dev/dist' } });

    // Should include the 4 default mounts + 1 extra
    expect(mounts).toHaveLength(5);
    expect(mounts[4]).toEqual({ name: 'ax-dev-dist', mountPath: '/opt/ax/dist' });
  });

  test('createPod works without extraVolumes (backwards compatible)', async () => {
    delete process.env.NATS_SANDBOX_PASS;

    const client = await createPoolK8sClient('ax');
    await client.createPod(basePodTemplate());

    const body = mockCreateNamespacedPod.mock.calls[0][0].body;
    expect(body.spec.volumes).toHaveLength(4);
    expect(body.spec.containers[0].volumeMounts).toHaveLength(4);
  });
});
