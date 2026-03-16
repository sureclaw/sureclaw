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

describe('nats-llm-proxy host integration', () => {
  // The host process starts a NATS LLM proxy for claude-code sessions in k8s
  // mode, so the sandbox pod's NATS bridge can reach the Anthropic API through
  // the host pod's credentials.

  test('host-process imports startNATSLLMProxy', () => {
    const source = readFileSync(
      join(__dirname, '../../src/host/host-process.ts'),
      'utf-8',
    );
    expect(source).toContain("import { startNATSLLMProxy } from './nats-llm-proxy.js'");
  });

  test('host-process starts LLM proxy for claude-code sessions in k8s mode', () => {
    const source = readFileSync(
      join(__dirname, '../../src/host/host-process.ts'),
      'utf-8',
    );
    // Proxy is started when agentType is claude-code AND sandbox is k8s
    expect(source).toContain("agentType === 'claude-code'");
    expect(source).toContain("config.providers.sandbox === 'k8s'");
    expect(source).toContain('startNATSLLMProxy');
  });
});
