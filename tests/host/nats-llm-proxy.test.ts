import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The LLM proxy requires a live NATS connection to test fully.
// These tests validate the module structure and agent-runtime wiring.
// Integration tests with a real NATS server are in the e2e test suite.

describe('nats-llm-proxy', () => {
  test('module exports startNATSLLMProxy function', async () => {
    const mod = await import('../../src/host/nats-llm-proxy.js');
    expect(typeof mod.startNATSLLMProxy).toBe('function');
  });
});

describe('nats-llm-proxy agent-runtime integration', () => {
  // The agent runtime process must start a NATS LLM proxy for claude-code
  // sessions in k8s mode, so the sandbox pod's NATS bridge can reach the
  // Anthropic API through the agent runtime pod's credentials.

  test('agent-runtime imports startNATSLLMProxy', () => {
    const source = readFileSync(
      join(__dirname, '../../src/host/agent-runtime-process.ts'),
      'utf-8',
    );
    expect(source).toContain("import { startNATSLLMProxy } from './nats-llm-proxy.js'");
  });

  test('agent-runtime starts LLM proxy for claude-code sessions in k8s mode', () => {
    const source = readFileSync(
      join(__dirname, '../../src/host/agent-runtime-process.ts'),
      'utf-8',
    );
    // Proxy is started when agentType is claude-code AND sandbox is k8s
    expect(source).toContain("request.agentType === 'claude-code'");
    expect(source).toContain("config.providers.sandbox === 'k8s'");
    expect(source).toContain('startNATSLLMProxy({ sessionId })');
  });

  test('agent-runtime closes LLM proxy after session completes', () => {
    const source = readFileSync(
      join(__dirname, '../../src/host/agent-runtime-process.ts'),
      'utf-8',
    );
    // Proxy cleanup happens in the finally block
    expect(source).toContain('llmProxy.close()');
  });
});
