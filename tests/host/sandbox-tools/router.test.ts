import { describe, test, expect } from 'vitest';
import { routeToolCall } from '../../../src/host/sandbox-tools/router.js';
import type { RouterConfig } from '../../../src/host/sandbox-tools/router.js';
import type { SandboxToolRequest } from '../../../src/host/sandbox-tools/types.js';

describe('SandboxToolRouter', () => {
  const enabledConfig: RouterConfig = { wasmEnabled: true, shadowMode: false };
  const disabledConfig: RouterConfig = { wasmEnabled: false, shadowMode: false };
  const shadowConfig: RouterConfig = { wasmEnabled: true, shadowMode: true };

  // ── Kill switch ──

  describe('kill switch (wasm disabled)', () => {
    test('routes read_file to Tier 2 when wasm disabled', () => {
      const route = routeToolCall({ type: 'read_file', path: 'test.txt' }, disabledConfig);
      expect(route.tier).toBe(2);
      expect(route.reason).toContain('wasm disabled');
    });

    test('routes write_file to Tier 2 when wasm disabled', () => {
      const route = routeToolCall({ type: 'write_file', path: 'test.txt', content: 'x' }, disabledConfig);
      expect(route.tier).toBe(2);
    });

    test('routes edit_file to Tier 2 when wasm disabled', () => {
      const route = routeToolCall(
        { type: 'edit_file', path: 'test.txt', old_string: 'a', new_string: 'b' },
        disabledConfig,
      );
      expect(route.tier).toBe(2);
    });

    test('routes bash to Tier 2 when wasm disabled', () => {
      const route = routeToolCall({ type: 'bash', command: 'pwd' }, disabledConfig);
      expect(route.tier).toBe(2);
    });
  });

  // ── WASM enabled: structured file ops ──

  describe('structured file ops (wasm enabled)', () => {
    test('routes read_file to Tier 1', () => {
      const route = routeToolCall({ type: 'read_file', path: 'test.txt' }, enabledConfig);
      expect(route.tier).toBe(1);
      expect(route.executor).toBe('wasm');
    });

    test('routes write_file to Tier 1', () => {
      const route = routeToolCall({ type: 'write_file', path: 'test.txt', content: 'x' }, enabledConfig);
      expect(route.tier).toBe(1);
      expect(route.executor).toBe('wasm');
    });

    test('routes edit_file to Tier 1', () => {
      const route = routeToolCall(
        { type: 'edit_file', path: 'test.txt', old_string: 'a', new_string: 'b' },
        enabledConfig,
      );
      expect(route.tier).toBe(1);
      expect(route.executor).toBe('wasm');
    });
  });

  // ── WASM enabled: bash classification ──

  describe('bash classification (wasm enabled)', () => {
    test('routes simple read-only command to Tier 1', () => {
      const route = routeToolCall({ type: 'bash', command: 'pwd' }, enabledConfig);
      expect(route.tier).toBe(1);
    });

    test('routes ls to Tier 1', () => {
      const route = routeToolCall({ type: 'bash', command: 'ls -la' }, enabledConfig);
      expect(route.tier).toBe(1);
    });

    test('routes git status to Tier 1', () => {
      const route = routeToolCall({ type: 'bash', command: 'git status' }, enabledConfig);
      expect(route.tier).toBe(1);
    });

    test('routes piped command to Tier 2', () => {
      const route = routeToolCall({ type: 'bash', command: 'cat file | grep pattern' }, enabledConfig);
      expect(route.tier).toBe(2);
      expect(route.reason).toContain('pipe');
    });

    test('routes npm test to Tier 2', () => {
      const route = routeToolCall({ type: 'bash', command: 'npm test' }, enabledConfig);
      expect(route.tier).toBe(2);
    });

    test('routes git push to Tier 2', () => {
      const route = routeToolCall({ type: 'bash', command: 'git push' }, enabledConfig);
      expect(route.tier).toBe(2);
    });
  });

  // ── Shadow mode ──

  describe('shadow mode', () => {
    test('routes Tier 1 candidates to Tier 2 in shadow mode', () => {
      const route = routeToolCall({ type: 'read_file', path: 'test.txt' }, shadowConfig);
      expect(route.tier).toBe(2);
      expect(route.reason).toContain('shadow mode');
      expect(route.reason).toContain('would have been tier 1');
    });

    test('keeps Tier 2 routes unchanged in shadow mode', () => {
      const route = routeToolCall({ type: 'bash', command: 'npm test' }, shadowConfig);
      expect(route.tier).toBe(2);
      expect(route.reason).not.toContain('shadow mode');
    });

    test('shadow mode logs the original Tier 1 reason', () => {
      const route = routeToolCall({ type: 'bash', command: 'pwd' }, shadowConfig);
      expect(route.tier).toBe(2);
      expect(route.reason).toContain('shadow mode');
      expect(route.reason).toContain('stateless read-only');
    });
  });

  // ── Audit trail ──

  describe('audit trail', () => {
    test('every route has a reason string', () => {
      const requests: SandboxToolRequest[] = [
        { type: 'bash', command: 'pwd' },
        { type: 'bash', command: 'npm install' },
        { type: 'bash', command: 'cat file | head' },
        { type: 'read_file', path: 'test.txt' },
        { type: 'write_file', path: 'test.txt', content: 'x' },
        { type: 'edit_file', path: 'test.txt', old_string: 'a', new_string: 'b' },
      ];
      for (const req of requests) {
        const route = routeToolCall(req, enabledConfig);
        expect(route.reason).toBeTruthy();
        expect(typeof route.reason).toBe('string');
      }
    });

    test('route has executor field', () => {
      const route = routeToolCall({ type: 'read_file', path: 'test.txt' }, enabledConfig);
      expect(route.executor).toBe('wasm');
    });
  });
});
