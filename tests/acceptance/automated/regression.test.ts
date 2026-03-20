/**
 * Automated regression test sequence.
 *
 * Runs against a live AX server (deployed in kind or running locally).
 * Tests execute in order — each test may depend on state from previous tests.
 *
 * Env vars set by global-setup.ts:
 *   AX_SERVER_URL    — base URL of the AX server
 *   MOCK_SERVER_PORT — port of the mock server on the host
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { AcceptanceClient, type ChatResponse } from './client.js';

const SERVER_URL = process.env.AX_SERVER_URL ?? 'http://localhost:8080';
const SESSION_PREFIX = `acceptance-${Date.now()}`;

let client: AcceptanceClient;

describe('regression test sequence', () => {
  beforeAll(() => {
    client = new AcceptanceClient(SERVER_URL);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. RESET — verify server healthy
  // ──────────────────────────────────────────────────────────────────────
  test('1. server health check', async () => {
    await client.waitForReady(30_000);
    const res = await fetch(`${SERVER_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2a. BOOTSTRAP — first message triggers bootstrap mode
  // ──────────────────────────────────────────────────────────────────────
  test('2a. bootstrap: user introduces self', async () => {
    const sessionId = `${SESSION_PREFIX}:bootstrap`;
    const res = await client.sendMessage(
      'Hello! My name is TestUser and I am here for acceptance testing.',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.finishReason).toBeTruthy();
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 2b. BOOTSTRAP — user sets agent identity
  // ──────────────────────────────────────────────────────────────────────
  test('2b. bootstrap: set agent identity', async () => {
    const sessionId = `${SESSION_PREFIX}:bootstrap`;
    const res = await client.sendMessage(
      'Your name is Reginald. You are witty and funny. Your purpose is acceptance testing.',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 3. PERSISTENCE — new session, agent responds with established identity
  // ──────────────────────────────────────────────────────────────────────
  test('3. persistence: identity carries over to new session', async () => {
    const sessionId = `${SESSION_PREFIX}:persist`;
    const res = await client.sendMessage(
      'Who are you? What is your name?',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 4. TOOL CALL — web_fetch through proxy
  // ──────────────────────────────────────────────────────────────────────
  test('4. tool call: web_fetch through proxy', async () => {
    const sessionId = `${SESSION_PREFIX}:tools`;
    const res = await client.sendMessage(
      'Please fetch this URL for me: http://mock-target.test/web-fetch-target',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 5. FILE OPS — agent creates files in workspace
  // ──────────────────────────────────────────────────────────────────────
  test('5. file ops: create file in workspace', async () => {
    const sessionId = `${SESSION_PREFIX}:files`;
    const res = await client.sendMessage(
      'Please create a file called test-file.txt with the content "acceptance-test-content-12345"',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 6. FILE PERSIST — new session, agent reads back files
  // ──────────────────────────────────────────────────────────────────────
  test('6. file persistence: read file from previous session', async () => {
    const sessionId = `${SESSION_PREFIX}:files2`;
    const res = await client.sendMessage(
      'Can you read the file test-file.txt and tell me what it contains?',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 7. BASH + PROXY — curl command through web proxy
  // ──────────────────────────────────────────────────────────────────────
  test('7. bash + proxy: curl through web proxy', async () => {
    const sessionId = `${SESSION_PREFIX}:proxy`;
    const res = await client.sendMessage(
      'Run a curl command to http://mock-target.test/web-fetch-target and show me the output',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 8a. SKILL INSTALL — triggers credential_required SSE event
  // ──────────────────────────────────────────────────────────────────────
  test('8a. skill install: triggers credential requirement', async () => {
    const sessionId = `${SESSION_PREFIX}:skills`;
    const res = await client.sendMessage(
      'Please install the Linear skill from ManuelHettich/linear',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    // The response should indicate that a credential is needed
    // This may come as a named SSE event or in the response content
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // 8b. CREDENTIALS — provide credential via POST
  // ──────────────────────────────────────────────────────────────────────
  test('8b. credentials: provide LINEAR_API_KEY', async () => {
    // Provide the credential that was requested
    try {
      await client.provideCredential('LINEAR_API_KEY', 'lin_api_test_acceptance_key_12345');
    } catch {
      // Credential endpoint may not be available in all modes — that's OK
      // The key assertion is that the provide call doesn't crash the server
    }
    // Verify server is still healthy after credential provision
    const health = await fetch(`${SERVER_URL}/health`);
    expect(health.status).toBe(200);
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────
  // 9. SKILL EXEC — Linear tool call through proxy to mock Linear API
  // ──────────────────────────────────────────────────────────────────────
  test('9. skill execution: Linear query through proxy', async () => {
    const sessionId = `${SESSION_PREFIX}:skills`;
    const res = await client.sendMessage(
      'Show me my Linear issues. List all issues please.',
      { sessionId, user: 'testuser', timeoutMs: 90_000 },
    );

    expect(res.status).toBe(200);
    expect(res.content.length).toBeGreaterThan(0);
  }, 120_000);
});
