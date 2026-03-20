import { describe, test, expect, afterEach } from 'vitest';
import {
  requestApproval,
  resolveApproval,
  isDomainApproved,
  isDomainDenied,
  cleanupSession,
  preApproveDomain,
} from '../../src/host/web-proxy-approvals.js';
import { createEventBus } from '../../src/host/event-bus.js';

describe('web-proxy-approvals', () => {
  const eventBus = createEventBus();

  afterEach(() => {
    cleanupSession('test-session');
  });

  test('requestApproval resolves true when approved via event bus', async () => {
    const promise = requestApproval('test-session', 'npmjs.org', eventBus, 'req-1');
    resolveApproval('test-session', 'npmjs.org', true, eventBus, 'req-1');
    expect(await promise).toBe(true);
  });

  test('requestApproval resolves false when denied via event bus', async () => {
    const promise = requestApproval('test-session', 'evil.com', eventBus, 'req-2');
    resolveApproval('test-session', 'evil.com', false, eventBus, 'req-2');
    expect(await promise).toBe(false);
  });

  test('caches approved domains', async () => {
    const p1 = requestApproval('test-session', 'npmjs.org', eventBus, 'req-3');
    resolveApproval('test-session', 'npmjs.org', true, eventBus, 'req-3');
    await p1;

    expect(isDomainApproved('test-session', 'npmjs.org')).toBe(true);

    // Second request resolves immediately from cache
    const result = await requestApproval('test-session', 'npmjs.org', eventBus, 'req-3b');
    expect(result).toBe(true);
  });

  test('caches denied domains', async () => {
    const p1 = requestApproval('test-session', 'evil.com', eventBus, 'req-4');
    resolveApproval('test-session', 'evil.com', false, eventBus, 'req-4');
    await p1;

    expect(isDomainDenied('test-session', 'evil.com')).toBe(true);

    // Second request resolves immediately from cache
    const result = await requestApproval('test-session', 'evil.com', eventBus, 'req-4b');
    expect(result).toBe(false);
  });

  test('mismatched requestId does not resolve', async () => {
    const promise = requestApproval('test-session', 'npmjs.org', eventBus, 'req-5', 200);
    // Publish on a different requestId — should not match
    resolveApproval('test-session', 'npmjs.org', true, eventBus, 'wrong-req');
    // Should timeout and resolve false
    expect(await promise).toBe(false);
  });

  test('cleanupSession clears caches', async () => {
    const p = requestApproval('test-session', 'npmjs.org', eventBus, 'req-6');
    resolveApproval('test-session', 'npmjs.org', true, eventBus, 'req-6');
    await p;

    expect(isDomainApproved('test-session', 'npmjs.org')).toBe(true);
    cleanupSession('test-session');
    expect(isDomainApproved('test-session', 'npmjs.org')).toBe(false);
  });

  test('sessions are independent', async () => {
    const p1 = requestApproval('session-a', 'npmjs.org', eventBus, 'req-7a');
    const p2 = requestApproval('session-b', 'npmjs.org', eventBus, 'req-7b');

    resolveApproval('session-a', 'npmjs.org', true, eventBus, 'req-7a');
    resolveApproval('session-b', 'npmjs.org', false, eventBus, 'req-7b');

    expect(await p1).toBe(true);
    expect(await p2).toBe(false);

    cleanupSession('session-a');
    cleanupSession('session-b');
  });

  test('preApproveDomain makes requestApproval resolve immediately', async () => {
    preApproveDomain('test-session', 'registry.npmjs.org');

    expect(isDomainApproved('test-session', 'registry.npmjs.org')).toBe(true);
    const result = await requestApproval('test-session', 'registry.npmjs.org', eventBus, 'req-8');
    expect(result).toBe(true);
  });

  test('preApproveDomain clears stale denial', async () => {
    // Deny first
    const p = requestApproval('test-session', 'evil.com', eventBus, 'req-9');
    resolveApproval('test-session', 'evil.com', false, eventBus, 'req-9');
    await p;
    expect(isDomainDenied('test-session', 'evil.com')).toBe(true);

    // Pre-approve overrides the denial
    preApproveDomain('test-session', 'evil.com');
    expect(isDomainApproved('test-session', 'evil.com')).toBe(true);
    expect(isDomainDenied('test-session', 'evil.com')).toBe(false);
  });

  test('host-process key works for k8s shared proxy', async () => {
    const p = requestApproval('host-process', 'pypi.org', eventBus, 'req-10');
    resolveApproval('host-process', 'pypi.org', true, eventBus, 'req-10');
    expect(await p).toBe(true);
    cleanupSession('host-process');
  });

  test('timeout resolves with false', async () => {
    const result = await requestApproval('test-session', 'slow.com', eventBus, 'req-11', 100);
    expect(result).toBe(false);
    expect(isDomainDenied('test-session', 'slow.com')).toBe(true);
  });
});
