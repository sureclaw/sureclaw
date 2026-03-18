import { describe, test, expect, afterEach } from 'vitest';
import {
  requestApproval,
  resolveApproval,
  isDomainApproved,
  isDomainDenied,
  cleanupSession,
  preApproveDomain,
} from '../../src/host/web-proxy-approvals.js';

describe('web-proxy-approvals', () => {
  afterEach(() => {
    cleanupSession('test-session');
  });

  test('requestApproval resolves true when approved', async () => {
    const promise = requestApproval('test-session', 'npmjs.org');
    const found = resolveApproval('test-session', 'npmjs.org', true);
    expect(found).toBe(true);
    expect(await promise).toBe(true);
  });

  test('requestApproval resolves false when denied', async () => {
    const promise = requestApproval('test-session', 'evil.com');
    resolveApproval('test-session', 'evil.com', false);
    expect(await promise).toBe(false);
  });

  test('caches approved domains', async () => {
    const p1 = requestApproval('test-session', 'npmjs.org');
    resolveApproval('test-session', 'npmjs.org', true);
    await p1;

    expect(isDomainApproved('test-session', 'npmjs.org')).toBe(true);

    // Second request resolves immediately from cache
    const result = await requestApproval('test-session', 'npmjs.org');
    expect(result).toBe(true);
  });

  test('caches denied domains', async () => {
    const p1 = requestApproval('test-session', 'evil.com');
    resolveApproval('test-session', 'evil.com', false);
    await p1;

    expect(isDomainDenied('test-session', 'evil.com')).toBe(true);

    // Second request resolves immediately from cache
    const result = await requestApproval('test-session', 'evil.com');
    expect(result).toBe(false);
  });

  test('resolveApproval returns false for unknown domain', () => {
    const found = resolveApproval('test-session', 'unknown.com', true);
    expect(found).toBe(false);
  });

  test('cleanupSession resolves pending with false', async () => {
    const promise = requestApproval('test-session', 'npmjs.org');
    cleanupSession('test-session');
    expect(await promise).toBe(false);
  });

  test('sessions are independent', async () => {
    const p1 = requestApproval('session-a', 'npmjs.org');
    const p2 = requestApproval('session-b', 'npmjs.org');

    resolveApproval('session-a', 'npmjs.org', true);
    resolveApproval('session-b', 'npmjs.org', false);

    expect(await p1).toBe(true);
    expect(await p2).toBe(false);

    cleanupSession('session-a');
    cleanupSession('session-b');
  });

  test('piggyback on pending request for same domain', async () => {
    const p1 = requestApproval('test-session', 'npmjs.org');
    const p2 = requestApproval('test-session', 'npmjs.org');

    resolveApproval('test-session', 'npmjs.org', true);

    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
  });

  test('preApproveDomain makes requestApproval resolve immediately', async () => {
    preApproveDomain('test-session', 'registry.npmjs.org');

    expect(isDomainApproved('test-session', 'registry.npmjs.org')).toBe(true);
    const result = await requestApproval('test-session', 'registry.npmjs.org');
    expect(result).toBe(true);
  });

  test('preApproveDomain clears stale denial', async () => {
    // Deny first
    const p = requestApproval('test-session', 'evil.com');
    resolveApproval('test-session', 'evil.com', false);
    await p;
    expect(isDomainDenied('test-session', 'evil.com')).toBe(true);

    // Pre-approve overrides the denial
    preApproveDomain('test-session', 'evil.com');
    expect(isDomainApproved('test-session', 'evil.com')).toBe(true);
    expect(isDomainDenied('test-session', 'evil.com')).toBe(false);
  });

  test('resolveApproval with host-process key matches k8s shared proxy', async () => {
    // Simulate k8s: proxy blocks under 'host-process', agent resolves under 'host-process'
    const p = requestApproval('host-process', 'pypi.org');
    const found = resolveApproval('host-process', 'pypi.org', true);
    expect(found).toBe(true);
    expect(await p).toBe(true);
    cleanupSession('host-process');
  });
});
