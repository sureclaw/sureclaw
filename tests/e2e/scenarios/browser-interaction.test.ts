/**
 * Scenario: Browser interaction operations
 *
 * Tests browser_click, browser_type, browser_screenshot, and browser_close
 * IPC actions — completing the browser coverage that was started in
 * full-pipeline.test.ts (which only tested launch, navigate, snapshot).
 *
 * Response shapes:
 *   browser_launch      → { ok, id }
 *   browser_navigate    → { ok: true }
 *   browser_snapshot    → { ok, title, url, text, refs }
 *   browser_click       → { ok: true }
 *   browser_type        → { ok: true }
 *   browser_screenshot  → { ok, data }  (base64-encoded image)
 *   browser_close       → { ok: true }
 */

import { describe, test, expect, afterEach } from 'vitest';
import { TestHarness } from '../harness.js';
import { textTurn, toolUseTurn } from '../scripted-llm.js';

describe('E2E Scenario: Browser Interaction', () => {
  let harness: TestHarness;

  afterEach(() => {
    harness?.dispose();
  });

  test('browser_click on a ref', async () => {
    harness = await TestHarness.create();

    // Launch and navigate first
    const launch = await harness.ipcCall('browser_launch', {});
    const sessionId = launch.id;

    await harness.ipcCall('browser_navigate', {
      session: sessionId,
      url: 'https://example.com/form',
    });

    const clickResult = await harness.ipcCall('browser_click', {
      session: sessionId,
      ref: 0,
    });

    expect(clickResult.ok).toBe(true);
  });

  test('browser_type enters text at a ref', async () => {
    harness = await TestHarness.create();

    const launch = await harness.ipcCall('browser_launch', {});

    const typeResult = await harness.ipcCall('browser_type', {
      session: launch.id,
      ref: 1,
      text: 'Hello, World!',
    });

    expect(typeResult.ok).toBe(true);
  });

  test('browser_screenshot returns base64 data', async () => {
    harness = await TestHarness.create();

    const launch = await harness.ipcCall('browser_launch', {});

    const screenshotResult = await harness.ipcCall('browser_screenshot', {
      session: launch.id,
    });

    expect(screenshotResult.ok).toBe(true);
    expect(screenshotResult.data).toBeDefined();
    // Verify it's base64 (should decode to our mock 'fake-png')
    expect(Buffer.from(screenshotResult.data, 'base64').toString()).toBe('fake-png');
  });

  test('browser_close terminates a session', async () => {
    harness = await TestHarness.create();

    const launch = await harness.ipcCall('browser_launch', {});

    const closeResult = await harness.ipcCall('browser_close', {
      session: launch.id,
    });

    expect(closeResult.ok).toBe(true);
  });

  test('full browser flow: launch → navigate → snapshot → click → type → screenshot → close', async () => {
    harness = await TestHarness.create({
      browserSnapshot: {
        title: 'Login Form',
        url: 'https://app.example.com/login',
        text: 'Username: [input] Password: [input] [Login]',
        refs: [
          { ref: 0, tag: 'input', text: 'Username' },
          { ref: 1, tag: 'input', text: 'Password' },
          { ref: 2, tag: 'button', text: 'Login' },
        ],
      },
    });

    // Launch
    const launch = await harness.ipcCall('browser_launch', {});
    expect(launch.id).toBeDefined();

    // Navigate
    const nav = await harness.ipcCall('browser_navigate', {
      session: launch.id,
      url: 'https://app.example.com/login',
    });
    expect(nav.ok).toBe(true);

    // Snapshot
    const snapshot = await harness.ipcCall('browser_snapshot', {
      session: launch.id,
    });
    expect(snapshot.title).toBe('Login Form');
    expect(snapshot.refs.length).toBe(3);

    // Type username
    const typeUser = await harness.ipcCall('browser_type', {
      session: launch.id,
      ref: 0,
      text: 'admin',
    });
    expect(typeUser.ok).toBe(true);

    // Type password
    const typePass = await harness.ipcCall('browser_type', {
      session: launch.id,
      ref: 1,
      text: 'secret123',
    });
    expect(typePass.ok).toBe(true);

    // Click login
    const click = await harness.ipcCall('browser_click', {
      session: launch.id,
      ref: 2,
    });
    expect(click.ok).toBe(true);

    // Screenshot
    const screenshot = await harness.ipcCall('browser_screenshot', {
      session: launch.id,
    });
    expect(screenshot.data).toBeDefined();

    // Close
    const close = await harness.ipcCall('browser_close', {
      session: launch.id,
    });
    expect(close.ok).toBe(true);
  });

  test('browser_navigate is audited', async () => {
    harness = await TestHarness.create();

    const launch = await harness.ipcCall('browser_launch', {});
    await harness.ipcCall('browser_navigate', {
      session: launch.id,
      url: 'https://example.com',
    });

    expect(harness.wasAudited('browser_navigate')).toBe(true);
    const entries = harness.auditEntriesFor('browser_navigate');
    expect(entries[0]!.args).toEqual({ url: 'https://example.com' });
  });

  test('multi-turn: LLM fills form via browser tools', async () => {
    harness = await TestHarness.create({
      browserSnapshot: {
        title: 'Search',
        url: 'https://search.example.com',
        text: 'Search: [input] [Go]',
        refs: [
          { ref: 0, tag: 'input', text: 'Search query' },
          { ref: 1, tag: 'button', text: 'Go' },
        ],
      },
      llmTurns: [
        // Turn 1: Launch browser
        toolUseTurn('browser_launch', {}),
        // Turn 2: Navigate
        toolUseTurn('browser_navigate', {
          session: 'PLACEHOLDER', // agent loop will use actual session from launch
          url: 'https://search.example.com',
        }),
        // Turn 3: Take snapshot to see the page
        toolUseTurn('browser_snapshot', { session: 'PLACEHOLDER' }),
        // Turn 4: Type search query
        toolUseTurn('browser_type', {
          session: 'PLACEHOLDER',
          ref: 0,
          text: 'TypeScript patterns',
        }),
        // Turn 5: Click search button
        toolUseTurn('browser_click', {
          session: 'PLACEHOLDER',
          ref: 1,
        }),
        // Turn 6: Close browser and respond
        textTurn('I searched for TypeScript patterns on the page.'),
      ],
    });

    const result = await harness.runAgentLoop('Search for TypeScript patterns on search.example.com');

    expect(result.toolCalls.length).toBe(5);
    expect(result.toolCalls.map(tc => tc.name)).toEqual([
      'browser_launch',
      'browser_navigate',
      'browser_snapshot',
      'browser_type',
      'browser_click',
    ]);
    expect(result.finalText).toContain('TypeScript patterns');
  });
});
