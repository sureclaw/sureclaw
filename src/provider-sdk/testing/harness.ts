/**
 * Provider Test Harness — contract test runner for AX providers.
 *
 * Validates that a provider implementation satisfies its interface contract.
 * Provider authors run this against their implementation to verify compliance
 * before publishing.
 *
 * Usage:
 *   import { ProviderTestHarness } from '@ax/provider-sdk/testing';
 *   const harness = new ProviderTestHarness('memory');
 *   await harness.run(myProvider);
 */

import type { MemoryProvider, MemoryEntry } from '../interfaces/index.js';
import type { ScannerProvider } from '../interfaces/index.js';
import type { AuditProvider } from '../interfaces/index.js';
import type { CredentialProvider } from '../interfaces/index.js';
import type { WebProvider } from '../interfaces/index.js';
import type { BrowserProvider } from '../interfaces/index.js';
import type { LLMProvider } from '../interfaces/index.js';
import type { ImageProvider } from '../interfaces/index.js';
import type { SchedulerProvider } from '../interfaces/index.js';
import type { SandboxProvider } from '../interfaces/index.js';
import type { ChannelProvider } from '../interfaces/index.js';

// ═══════════════════════════════════════════════════════
// Test Result Types
// ═══════════════════════════════════════════════════════

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface HarnessResult {
  kind: ProviderKind;
  passed: number;
  failed: number;
  results: TestResult[];
}

// ═══════════════════════════════════════════════════════
// Supported Provider Kinds
// ═══════════════════════════════════════════════════════

export type ProviderKind =
  | 'llm' | 'image' | 'memory' | 'scanner' | 'channel'
  | 'web' | 'browser' | 'credentials'
  | 'audit' | 'sandbox' | 'scheduler';

type ProviderForKind<K extends ProviderKind> =
  K extends 'llm' ? LLMProvider :
  K extends 'image' ? ImageProvider :
  K extends 'memory' ? MemoryProvider :
  K extends 'scanner' ? ScannerProvider :
  K extends 'channel' ? ChannelProvider :
  K extends 'web' ? WebProvider :
  K extends 'browser' ? BrowserProvider :
  K extends 'credentials' ? CredentialProvider :
  K extends 'audit' ? AuditProvider :
  K extends 'sandbox' ? SandboxProvider :
  K extends 'scheduler' ? SchedulerProvider :
  never;

// ═══════════════════════════════════════════════════════
// Contract definitions per provider kind
// ═══════════════════════════════════════════════════════

interface ContractTest<T> {
  name: string;
  run: (provider: T) => Promise<void>;
}

function memoryContract(): ContractTest<MemoryProvider>[] {
  return [
    {
      name: 'write returns a string ID',
      async run(provider) {
        const id = await provider.write({ scope: 'test', content: 'hello' });
        assertType(id, 'string', 'write() must return a string ID');
        assert(id.length > 0, 'write() must return a non-empty ID');
      },
    },
    {
      name: 'read returns written entry',
      async run(provider) {
        const id = await provider.write({ scope: 'test-read', content: 'read me' });
        const entry = await provider.read(id);
        assert(entry !== null, 'read() must find the written entry');
        assert(entry!.content === 'read me', 'read() must return correct content');
      },
    },
    {
      name: 'query returns matching entries',
      async run(provider) {
        await provider.write({ scope: 'test-query', content: 'findable content' });
        const results = await provider.query({ scope: 'test-query' });
        assertType(results, 'array', 'query() must return an array');
        assert(results.length > 0, 'query() must find the written entry');
      },
    },
    {
      name: 'delete removes an entry',
      async run(provider) {
        const id = await provider.write({ scope: 'test-delete', content: 'delete me' });
        await provider.delete(id);
        const entry = await provider.read(id);
        assert(entry === null, 'read() must return null after delete');
      },
    },
    {
      name: 'list returns entries for scope',
      async run(provider) {
        await provider.write({ scope: 'test-list', content: 'list entry' });
        const results = await provider.list('test-list');
        assertType(results, 'array', 'list() must return an array');
        assert(results.length > 0, 'list() must find entries in scope');
      },
    },
  ];
}

function scannerContract(): ContractTest<ScannerProvider>[] {
  return [
    {
      name: 'scanInput returns a ScanResult',
      async run(provider) {
        const result = await provider.scanInput({
          content: 'hello world',
          source: 'test',
          sessionId: 'test-session',
        });
        assert(
          ['PASS', 'FLAG', 'BLOCK'].includes(result.verdict),
          `scanInput() verdict must be PASS/FLAG/BLOCK, got "${result.verdict}"`,
        );
      },
    },
    {
      name: 'scanOutput returns a ScanResult',
      async run(provider) {
        const result = await provider.scanOutput({
          content: 'hello world',
          source: 'test',
          sessionId: 'test-session',
        });
        assert(
          ['PASS', 'FLAG', 'BLOCK'].includes(result.verdict),
          `scanOutput() verdict must be PASS/FLAG/BLOCK, got "${result.verdict}"`,
        );
      },
    },
    {
      name: 'canaryToken returns a non-empty string',
      async run(provider) {
        const token = provider.canaryToken();
        assertType(token, 'string', 'canaryToken() must return a string');
        assert(token.length > 0, 'canaryToken() must be non-empty');
      },
    },
    {
      name: 'checkCanary detects embedded token',
      async run(provider) {
        const token = provider.canaryToken();
        const detected = provider.checkCanary(`output contains ${token} here`, token);
        assert(detected === true, 'checkCanary() must detect the token in output');
      },
    },
  ];
}

function auditContract(): ContractTest<AuditProvider>[] {
  return [
    {
      name: 'log accepts a partial entry without throwing',
      async run(provider) {
        await provider.log({
          action: 'test_action',
          sessionId: 'test-session',
          args: { key: 'value' },
          result: 'success',
        });
      },
    },
    {
      name: 'query returns an array',
      async run(provider) {
        const results = await provider.query({});
        assertType(results, 'array', 'query() must return an array');
      },
    },
  ];
}

function credentialContract(): ContractTest<CredentialProvider>[] {
  return [
    {
      name: 'get returns null for unknown service',
      async run(provider) {
        const val = await provider.get('nonexistent-test-service-' + Date.now());
        assert(val === null, 'get() must return null for unknown services');
      },
    },
    {
      name: 'set and get round-trip',
      async run(provider) {
        const key = 'test-service-' + Date.now();
        await provider.set(key, 'secret-value');
        const val = await provider.get(key);
        assert(val === 'secret-value', 'get() must return the value set by set()');
        await provider.delete(key);
      },
    },
    {
      name: 'list returns an array',
      async run(provider) {
        const result = await provider.list();
        assertType(result, 'array', 'list() must return an array');
      },
    },
  ];
}

function webContract(): ContractTest<WebProvider>[] {
  return [
    {
      name: 'fetch is a function',
      async run(provider) {
        assertType(provider.fetch, 'function', 'fetch must be a function');
      },
    },
    {
      name: 'search is a function',
      async run(provider) {
        assertType(provider.search, 'function', 'search must be a function');
      },
    },
  ];
}

function browserContract(): ContractTest<BrowserProvider>[] {
  return [
    {
      name: 'launch is a function',
      async run(provider) {
        assertType(provider.launch, 'function', 'launch must be a function');
      },
    },
    {
      name: 'navigate is a function',
      async run(provider) {
        assertType(provider.navigate, 'function', 'navigate must be a function');
      },
    },
    {
      name: 'snapshot is a function',
      async run(provider) {
        assertType(provider.snapshot, 'function', 'snapshot must be a function');
      },
    },
    {
      name: 'close is a function',
      async run(provider) {
        assertType(provider.close, 'function', 'close must be a function');
      },
    },
  ];
}

function llmContract(): ContractTest<LLMProvider>[] {
  return [
    {
      name: 'name is a non-empty string',
      async run(provider) {
        assertType(provider.name, 'string', 'name must be a string');
        assert(provider.name.length > 0, 'name must be non-empty');
      },
    },
    {
      name: 'chat is a function',
      async run(provider) {
        assertType(provider.chat, 'function', 'chat must be a function');
      },
    },
    {
      name: 'models is a function',
      async run(provider) {
        assertType(provider.models, 'function', 'models must be a function');
      },
    },
  ];
}

function imageContract(): ContractTest<ImageProvider>[] {
  return [
    {
      name: 'name is a non-empty string',
      async run(provider) {
        assertType(provider.name, 'string', 'name must be a string');
        assert(provider.name.length > 0, 'name must be non-empty');
      },
    },
    {
      name: 'generate is a function',
      async run(provider) {
        assertType(provider.generate, 'function', 'generate must be a function');
      },
    },
    {
      name: 'models is a function',
      async run(provider) {
        assertType(provider.models, 'function', 'models must be a function');
      },
    },
  ];
}

function schedulerContract(): ContractTest<SchedulerProvider>[] {
  return [
    {
      name: 'start is a function',
      async run(provider) {
        assertType(provider.start, 'function', 'start must be a function');
      },
    },
    {
      name: 'stop is a function',
      async run(provider) {
        assertType(provider.stop, 'function', 'stop must be a function');
      },
    },
  ];
}

function sandboxContract(): ContractTest<SandboxProvider>[] {
  return [
    {
      name: 'spawn is a function',
      async run(provider) {
        assertType(provider.spawn, 'function', 'spawn must be a function');
      },
    },
    {
      name: 'kill is a function',
      async run(provider) {
        assertType(provider.kill, 'function', 'kill must be a function');
      },
    },
    {
      name: 'isAvailable is a function',
      async run(provider) {
        assertType(provider.isAvailable, 'function', 'isAvailable must be a function');
      },
    },
  ];
}

function channelContract(): ContractTest<ChannelProvider>[] {
  return [
    {
      name: 'name is a non-empty string',
      async run(provider) {
        assertType(provider.name, 'string', 'name must be a string');
        assert(provider.name.length > 0, 'name must be non-empty');
      },
    },
    {
      name: 'connect is a function',
      async run(provider) {
        assertType(provider.connect, 'function', 'connect must be a function');
      },
    },
    {
      name: 'onMessage is a function',
      async run(provider) {
        assertType(provider.onMessage, 'function', 'onMessage must be a function');
      },
    },
    {
      name: 'send is a function',
      async run(provider) {
        assertType(provider.send, 'function', 'send must be a function');
      },
    },
    {
      name: 'disconnect is a function',
      async run(provider) {
        assertType(provider.disconnect, 'function', 'disconnect must be a function');
      },
    },
  ];
}

// ═══════════════════════════════════════════════════════
// Contract registry
// ═══════════════════════════════════════════════════════

const CONTRACTS: Record<ProviderKind, () => ContractTest<any>[]> = {
  llm: llmContract,
  image: imageContract,
  memory: memoryContract,
  scanner: scannerContract,
  channel: channelContract,
  web: webContract,
  browser: browserContract,
  credentials: credentialContract,
  audit: auditContract,
  sandbox: sandboxContract,
  scheduler: schedulerContract,
};

// ═══════════════════════════════════════════════════════
// Harness
// ═══════════════════════════════════════════════════════

export class ProviderTestHarness<K extends ProviderKind> {
  private kind: K;

  constructor(kind: K) {
    if (!(kind in CONTRACTS)) {
      throw new Error(`Unknown provider kind: "${kind}". Valid: ${Object.keys(CONTRACTS).join(', ')}`);
    }
    this.kind = kind;
  }

  /**
   * Run all contract tests against a provider implementation.
   * Returns a structured result with pass/fail counts.
   */
  async run(provider: ProviderForKind<K>): Promise<HarnessResult> {
    const tests = CONTRACTS[this.kind]();
    const results: TestResult[] = [];

    for (const test of tests) {
      try {
        await test.run(provider);
        results.push({ name: test.name, passed: true });
      } catch (err) {
        results.push({
          name: test.name,
          passed: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      kind: this.kind,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      results,
    };
  }

  /** Get the list of test names without running them. */
  listTests(): string[] {
    return CONTRACTS[this.kind]().map(t => t.name);
  }
}

// ═══════════════════════════════════════════════════════
// Assertion helpers
// ═══════════════════════════════════════════════════════

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Contract violation: ${message}`);
}

function assertType(value: unknown, expected: string, message: string): void {
  if (expected === 'array') {
    if (!Array.isArray(value)) throw new Error(`Contract violation: ${message} (got ${typeof value})`);
    return;
  }
  if (typeof value !== expected) {
    throw new Error(`Contract violation: ${message} (got ${typeof value})`);
  }
}
