/**
 * Scenario: Web search and fetch operations
 *
 * Tests web_search and web_fetch IPC actions with configurable
 * stub responses, plus multi-turn flows where the LLM uses
 * web tools and synthesizes results.
 *
 * Note: The web_search handler returns the SearchResult[] directly
 * (spread into the response as array indices), and web_fetch returns
 * FetchResponse directly (spread as flat keys: status, headers, body, taint).
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';

describe('E2E Scenario: Web Search & Fetch', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('web_search returns canned results', async () => {
    harness = await TestHarness.create({
      webSearches: [{
        query: 'TypeScript best practices',
        results: [
          {
            title: 'TS Best Practices 2025',
            url: 'https://example.com/ts-best',
            snippet: 'Use strict mode, enable all checks...',
            taint: { source: 'web_search', trust: 'external', timestamp: new Date() },
          },
          {
            title: 'Advanced TypeScript Patterns',
            url: 'https://example.com/ts-advanced',
            snippet: 'Branded types, conditional types...',
            taint: { source: 'web_search', trust: 'external', timestamp: new Date() },
          },
        ],
      }],
    });

    const result = await harness.ipcCall('web_search', {
      query: 'TypeScript best practices',
    });

    expect(result.ok).toBe(true);
    // web_search handler spreads SearchResult[] as array indices (0, 1, ...)
    expect(result[0].title).toBe('TS Best Practices 2025');
    expect(result[0].taint.trust).toBe('external');
    expect(result[1].title).toBe('Advanced TypeScript Patterns');
  });

  test('web_search returns default mock when no stub matches', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('web_search', {
      query: 'anything at all',
    });

    expect(result.ok).toBe(true);
    expect(result[0]).toBeDefined();
    expect(result[0].snippet).toContain('anything at all');
  });

  test('web_fetch returns canned response for matched URL', async () => {
    harness = await TestHarness.create({
      webFetches: [{
        url: 'https://api.example.com/data',
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"status": "ok", "data": [1, 2, 3]}',
          taint: { source: 'web_fetch', trust: 'external', timestamp: new Date() },
        },
      }],
    });

    const result = await harness.ipcCall('web_fetch', {
      url: 'https://api.example.com/data',
    });

    expect(result.ok).toBe(true);
    // web_fetch handler spreads FetchResponse directly (status, headers, body, taint)
    expect(result.status).toBe(200);
    expect(result.body).toContain('"status": "ok"');
    expect(result.taint.trust).toBe('external');
  });

  test('web_fetch with regex URL matching', async () => {
    harness = await TestHarness.create({
      webFetches: [{
        url: /example\.com\/api\/.*/,
        response: {
          status: 200,
          headers: {},
          body: 'Matched by regex',
          taint: { source: 'web_fetch', trust: 'external', timestamp: new Date() },
        },
      }],
    });

    const result = await harness.ipcCall('web_fetch', {
      url: 'https://example.com/api/users/123',
    });

    expect(result.ok).toBe(true);
    expect(result.body).toBe('Matched by regex');
  });

  test('web_fetch returns default mock for unmatched URLs', async () => {
    harness = await TestHarness.create();

    const result = await harness.ipcCall('web_fetch', {
      url: 'https://unknown-site.com/page',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toContain('Mock page');
  });

  test('web operations are audited', async () => {
    harness = await TestHarness.create();

    await harness.ipcCall('web_search', { query: 'test' });
    await harness.ipcCall('web_fetch', { url: 'https://example.com' });

    expect(harness.wasAudited('web_search')).toBe(true);
    expect(harness.wasAudited('web_fetch')).toBe(true);
  });

  test('multi-turn: LLM searches web then synthesizes answer', async () => {
    harness = await TestHarness.create({
      webSearches: [{
        query: /weather/i,
        results: [{
          title: 'Weather Forecast',
          url: 'https://weather.example.com',
          snippet: 'Today: Sunny, 72°F. Tomorrow: Cloudy, 65°F.',
          taint: { source: 'web_search', trust: 'external', timestamp: new Date() },
        }],
      }],
      llmTurns: [
        // Turn 1: LLM decides to search the web
        toolUseTurn('web_search', { query: 'weather forecast today' }),
        // Turn 2: LLM synthesizes the search results
        textTurn('Based on the search results, it\'s sunny and 72°F today.'),
      ],
    });

    const result = await harness.runAgentLoop('What\'s the weather like?');

    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.name).toBe('web_search');
    expect(result.finalText).toContain('sunny');
    expect(result.finalText).toContain('72');
  });

  test('multi-turn: LLM fetches a URL then processes content', async () => {
    harness = await TestHarness.create({
      webFetches: [{
        url: 'https://docs.example.com/api',
        response: {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html><body><h1>API Docs</h1><p>POST /users - Create user</p></body></html>',
          taint: { source: 'web_fetch', trust: 'external', timestamp: new Date() },
        },
      }],
      llmTurns: [
        // Turn 1: Fetch the docs
        toolUseTurn('web_fetch', { url: 'https://docs.example.com/api' }),
        // Turn 2: Summarize
        textTurn('The API has a POST /users endpoint for creating users.'),
      ],
    });

    const result = await harness.runAgentLoop('What endpoints does the API have?');

    expect(result.toolCalls[0]!.name).toBe('web_fetch');
    expect(result.finalText).toContain('POST /users');
  });
});
