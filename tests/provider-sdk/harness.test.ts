import { describe, test, expect } from 'vitest';
import { ProviderTestHarness } from '../../src/provider-sdk/testing/harness.js';
import type { MemoryProvider, MemoryEntry, MemoryQuery } from '../../src/provider-sdk/interfaces/index.js';
import type { SecurityProvider, ScanTarget, ScanResult } from '../../src/provider-sdk/interfaces/index.js';
import type { AuditProvider, AuditEntry, AuditFilter } from '../../src/provider-sdk/interfaces/index.js';
import type { CredentialProvider } from '../../src/provider-sdk/interfaces/index.js';

// ═══════════════════════════════════════════════════════
// Mock providers for testing the harness itself
// ═══════════════════════════════════════════════════════

function createMockMemoryProvider(): MemoryProvider {
  const store = new Map<string, MemoryEntry>();

  return {
    async write(entry) {
      const id = entry.id ?? `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      store.set(id, { ...entry, id });
      return id;
    },
    async query(q) {
      return [...store.values()].filter(e => e.scope === q.scope).slice(0, q.limit ?? 50);
    },
    async read(id) {
      return store.get(id) ?? null;
    },
    async delete(id) {
      store.delete(id);
    },
    async list(scope, limit) {
      return [...store.values()].filter(e => e.scope === scope).slice(0, limit ?? 50);
    },
  };
}

function createMockSecurityProvider(): SecurityProvider {
  return {
    async scanInput(_msg) {
      return { verdict: 'PASS' };
    },
    async scanOutput(_msg) {
      return { verdict: 'PASS' };
    },
    canaryToken() {
      return `canary-${Date.now()}`;
    },
    checkCanary(output, token) {
      return output.includes(token);
    },
    async screen() {
      return { allowed: true, reasons: [] };
    },
    async screenExtended() {
      return { verdict: 'APPROVE', score: 0, reasons: [], permissions: [], excessPermissions: [] };
    },
    async screenBatch(items) {
      return items.map(() => ({ verdict: 'APPROVE' as const, score: 0, reasons: [], permissions: [], excessPermissions: [] }));
    },
  };
}

function createMockAuditProvider(): AuditProvider {
  const entries: AuditEntry[] = [];
  return {
    async log(entry) {
      entries.push({
        timestamp: new Date(),
        sessionId: entry.sessionId ?? 'unknown',
        action: entry.action ?? 'unknown',
        args: entry.args ?? {},
        result: entry.result ?? 'success',
        durationMs: entry.durationMs ?? 0,
      });
    },
    async query(_filter) {
      return entries;
    },
  };
}

function createMockCredentialProvider(): CredentialProvider {
  const store = new Map<string, string>();
  return {
    async get(service) { return store.get(service) ?? null; },
    async set(service, value) { store.set(service, value); },
    async delete(service) { store.delete(service); },
    async list() { return [...store.keys()]; },
  };
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe('ProviderTestHarness', () => {
  test('rejects unknown provider kind', () => {
    expect(() => new ProviderTestHarness('unknown' as any)).toThrow('Unknown provider kind');
  });

  test('listTests returns test names without running them', () => {
    const harness = new ProviderTestHarness('memory');
    const tests = harness.listTests();
    expect(Array.isArray(tests)).toBe(true);
    expect(tests.length).toBeGreaterThan(0);
    expect(tests).toContain('write returns a string ID');
  });

  describe('memory contract', () => {
    test('all tests pass for a valid implementation', async () => {
      const harness = new ProviderTestHarness('memory');
      const provider = createMockMemoryProvider();
      const result = await harness.run(provider);

      expect(result.kind).toBe('memory');
      expect(result.failed).toBe(0);
      expect(result.passed).toBeGreaterThan(0);
      expect(result.results.every(r => r.passed)).toBe(true);
    });

    test('detects broken write implementation', async () => {
      const harness = new ProviderTestHarness('memory');
      const broken: MemoryProvider = {
        async write() { return ''; }, // Empty string — should fail
        async query() { return []; },
        async read() { return null; },
        async delete() {},
        async list() { return []; },
      };
      const result = await harness.run(broken);
      expect(result.failed).toBeGreaterThan(0);
    });
  });

  describe('security contract', () => {
    test('all tests pass for a valid implementation', async () => {
      const harness = new ProviderTestHarness('security');
      const result = await harness.run(createMockSecurityProvider());
      expect(result.failed).toBe(0);
      expect(result.passed).toBeGreaterThan(0);
    });
  });

  describe('audit contract', () => {
    test('all tests pass for a valid implementation', async () => {
      const harness = new ProviderTestHarness('audit');
      const result = await harness.run(createMockAuditProvider());
      expect(result.failed).toBe(0);
      expect(result.passed).toBeGreaterThan(0);
    });
  });

  describe('credentials contract', () => {
    test('all tests pass for a valid implementation', async () => {
      const harness = new ProviderTestHarness('credentials');
      const result = await harness.run(createMockCredentialProvider());
      expect(result.failed).toBe(0);
      expect(result.passed).toBeGreaterThan(0);
    });
  });
});
