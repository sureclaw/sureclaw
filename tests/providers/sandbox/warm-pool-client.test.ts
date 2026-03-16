// tests/providers/sandbox/warm-pool-client.test.ts — Warm pool client tests
//
// Tests the warm pool claiming logic with mocked k8s API.

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock pod responses
const mockPods: any[] = [];
const mockListNamespacedPod = vi.fn().mockImplementation(async () => ({
  items: mockPods,
}));
const mockPatchNamespacedPod = vi.fn().mockResolvedValue({});
const mockDeleteNamespacedPod = vi.fn().mockResolvedValue({});

class MockKubeConfig {
  loadFromCluster() { throw new Error('not in cluster'); }
  loadFromDefault() {}
  makeApiClient() {
    return {
      listNamespacedPod: mockListNamespacedPod,
      patchNamespacedPod: mockPatchNamespacedPod,
      deleteNamespacedPod: mockDeleteNamespacedPod,
    };
  }
}

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: MockKubeConfig,
  CoreV1Api: class {},
}));

function makePod(name: string, phase: string, createdMinutesAgo: number = 0) {
  return {
    metadata: {
      name,
      labels: {
        'app.kubernetes.io/name': 'ax-sandbox',
        'ax.io/tier': 'light',
        'ax.io/status': 'warm',
      },
      creationTimestamp: new Date(Date.now() - createdMinutesAgo * 60_000).toISOString(),
    },
    status: { phase },
  };
}

describe('warm-pool-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPods.length = 0;
  });

  test('claimPod returns null when no warm pods exist', async () => {
    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');
    expect(result).toBeNull();
    expect(mockPatchNamespacedPod).not.toHaveBeenCalled();
  });

  test('claimPod claims the oldest Running pod', async () => {
    mockPods.push(
      makePod('pod-new', 'Running', 1),
      makePod('pod-old', 'Running', 5),
    );

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');

    expect(result).toEqual({ name: 'pod-old', tier: 'light' });
    expect(mockPatchNamespacedPod).toHaveBeenCalledOnce();
    expect(mockPatchNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'test-ns',
        name: 'pod-old',
        body: [
          { op: 'test', path: '/metadata/labels/ax.io~1status', value: 'warm' },
          { op: 'replace', path: '/metadata/labels/ax.io~1status', value: 'claimed' },
        ],
      }),
    );
  });

  test('claimPod skips Pending pods', async () => {
    mockPods.push(
      makePod('pod-pending', 'Pending', 5),
      makePod('pod-running', 'Running', 1),
    );

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');

    expect(result).toEqual({ name: 'pod-running', tier: 'light' });
  });

  test('claimPod retries on 409 Conflict', async () => {
    mockPods.push(
      makePod('pod-contested', 'Running', 5),
      makePod('pod-available', 'Running', 1),
    );

    // First patch fails with 409, second succeeds
    mockPatchNamespacedPod
      .mockRejectedValueOnce({ response: { statusCode: 409 } })
      .mockResolvedValueOnce({});

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');

    expect(result).toEqual({ name: 'pod-available', tier: 'light' });
    expect(mockPatchNamespacedPod).toHaveBeenCalledTimes(2);
  });

  test('claimPod retries on 422 (JSON Patch test failed — already claimed)', async () => {
    mockPods.push(
      makePod('pod-already-claimed', 'Running', 5),
      makePod('pod-still-warm', 'Running', 1),
    );

    // First patch fails with 422 (JSON Patch test op failed), second succeeds
    mockPatchNamespacedPod
      .mockRejectedValueOnce({ response: { statusCode: 422 } })
      .mockResolvedValueOnce({});

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');

    expect(result).toEqual({ name: 'pod-still-warm', tier: 'light' });
    expect(mockPatchNamespacedPod).toHaveBeenCalledTimes(2);
  });

  test('claimPod uses JSON Patch with test precondition', async () => {
    mockPods.push(makePod('pod-atomic', 'Running', 1));

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    await client.claimPod('light');

    expect(mockPatchNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'pod-atomic',
        body: [
          { op: 'test', path: '/metadata/labels/ax.io~1status', value: 'warm' },
          { op: 'replace', path: '/metadata/labels/ax.io~1status', value: 'claimed' },
        ],
      }),
    );
  });

  test('claimPod retries on 404 Not Found', async () => {
    mockPods.push(
      makePod('pod-gone', 'Running', 5),
      makePod('pod-here', 'Running', 1),
    );

    mockPatchNamespacedPod
      .mockRejectedValueOnce({ response: { statusCode: 404 } })
      .mockResolvedValueOnce({});

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');

    expect(result).toEqual({ name: 'pod-here', tier: 'light' });
  });

  test('claimPod returns null when all claims fail', async () => {
    mockPods.push(
      makePod('pod-a', 'Running', 5),
      makePod('pod-b', 'Running', 1),
    );

    mockPatchNamespacedPod
      .mockRejectedValueOnce({ response: { statusCode: 409 } })
      .mockRejectedValueOnce({ response: { statusCode: 404 } });

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');
    expect(result).toBeNull();
  });

  test('claimPod returns null on API error (non-conflict)', async () => {
    mockPods.push(makePod('pod-a', 'Running', 1));

    mockPatchNamespacedPod.mockRejectedValueOnce({
      response: { statusCode: 500 },
      message: 'Internal Server Error',
    });

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    const result = await client.claimPod('light');
    expect(result).toBeNull();
  });

  test('claimPod uses correct label selector', async () => {
    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    await client.claimPod('heavy');

    expect(mockListNamespacedPod).toHaveBeenCalledWith({
      namespace: 'test-ns',
      labelSelector: 'app.kubernetes.io/name=ax-sandbox,ax.io/tier=heavy,ax.io/status=warm',
    });
  });

  test('releasePod deletes the pod', async () => {
    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    await client.releasePod('pod-done');

    expect(mockDeleteNamespacedPod).toHaveBeenCalledWith({
      namespace: 'test-ns',
      name: 'pod-done',
      gracePeriodSeconds: 10,
    });
  });

  test('releasePod ignores 404 (already deleted)', async () => {
    mockDeleteNamespacedPod.mockRejectedValueOnce({
      response: { statusCode: 404 },
    });

    const { createWarmPoolClient } = await import(
      '../../../src/providers/sandbox/warm-pool-client.js'
    );
    const client = await createWarmPoolClient('test-ns');

    // Should not throw
    await client.releasePod('pod-gone');
  });
});
