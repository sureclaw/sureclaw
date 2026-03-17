import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The LLM proxy requires a live NATS connection to test fully.
// These tests validate the module structure and host-process wiring.
// Integration tests with a real NATS server are in the e2e test suite.

describe('nats-llm-proxy', () => {
  test('module exports startNATSLLMProxy function', async () => {
    const mod = await import('../../src/host/nats-llm-proxy.js');
    expect(typeof mod.startNATSLLMProxy).toBe('function');
  });
});

describe('nats-llm-proxy host integration (replaced by HTTP routes)', () => {
  // NATS LLM proxy has been replaced by /internal/llm-proxy HTTP route.
  // These tests verify the replacement wiring in host-process.ts.

  test('host-process uses HTTP /internal/llm-proxy route instead of NATS proxy', () => {
    const source = readFileSync(
      join(__dirname, '../../src/host/host-process.ts'),
      'utf-8',
    );
    expect(source).toContain('/internal/llm-proxy/');
    expect(source).toContain('activeTokens');
  });

  test('host-process registers per-turn tokens for HTTP IPC', () => {
    const source = readFileSync(
      join(__dirname, '../../src/host/host-process.ts'),
      'utf-8',
    );
    expect(source).toContain('activeTokens.set(turnToken');
    expect(source).toContain('activeTokens.delete(turnToken)');
  });
});
