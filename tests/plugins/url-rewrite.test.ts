import { describe, test, expect } from 'vitest';
import { applyUrlRewrite } from '../../src/plugins/url-rewrite.js';

describe('applyUrlRewrite', () => {
  test('returns original when rewrites is undefined', () => {
    const url = 'https://api.example.com/path';
    expect(applyUrlRewrite(url, undefined)).toBe(url);
  });

  test('returns original when rewrites is empty', () => {
    const url = 'https://api.example.com/path';
    expect(applyUrlRewrite(url, {})).toBe(url);
    expect(applyUrlRewrite(url, new Map())).toBe(url);
  });

  test('returns original when no hostname match', () => {
    const url = 'https://unmapped.example.com/path';
    expect(applyUrlRewrite(url, { 'other.example.com': 'http://mock:1234' })).toBe(url);
  });

  test('rewrites origin while preserving path and query', () => {
    const url = 'https://api.linear.app/graphql?foo=bar&baz=qux';
    const rewrites = { 'api.linear.app': 'http://0.0.0.0:9999' };
    expect(applyUrlRewrite(url, rewrites)).toBe(
      'http://0.0.0.0:9999/graphql?foo=bar&baz=qux',
    );
  });

  test('preserves path when rewrite target has no trailing path', () => {
    expect(
      applyUrlRewrite('https://mock-target.test/mcp/linear', {
        'mock-target.test': 'http://127.0.0.1:8080',
      }),
    ).toBe('http://127.0.0.1:8080/mcp/linear');
  });

  test('prepends rewrite target path when present', () => {
    expect(
      applyUrlRewrite('https://mock-target.test/mcp/linear', {
        'mock-target.test': 'http://127.0.0.1:8080/prefix',
      }),
    ).toBe('http://127.0.0.1:8080/prefix/mcp/linear');
  });

  test('returns original when input URL is unparseable', () => {
    expect(applyUrlRewrite('not-a-url', { host: 'http://x' })).toBe('not-a-url');
  });

  test('returns original when replacement is unparseable', () => {
    const url = 'https://api.example.com/path';
    expect(applyUrlRewrite(url, { 'api.example.com': 'not-a-url' })).toBe(url);
  });

  test('matches hostname case-insensitively', () => {
    expect(
      applyUrlRewrite('https://API.Linear.APP/graphql', {
        'api.linear.app': 'http://0.0.0.0:9999',
      }),
    ).toBe('http://0.0.0.0:9999/graphql');
  });

  test('accepts Map form for rewrites', () => {
    const rewrites = new Map([['api.linear.app', 'http://0.0.0.0:9999']]);
    expect(applyUrlRewrite('https://api.linear.app/x', rewrites)).toBe(
      'http://0.0.0.0:9999/x',
    );
  });
});
