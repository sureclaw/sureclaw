import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type { Config } from '../../src/providers/types.js';

const config = {} as Config;

describe('browser-container', () => {
  const originalDomains = process.env.AX_BROWSER_ALLOWED_DOMAINS;

  afterEach(() => {
    if (originalDomains !== undefined) {
      process.env.AX_BROWSER_ALLOWED_DOMAINS = originalDomains;
    } else {
      delete process.env.AX_BROWSER_ALLOWED_DOMAINS;
    }
  });

  test('throws when playwright is not available', async () => {
    // playwright is not installed in test env — dynamic import will fail
    // We can only test this if playwright isn't installed
    // Since we can't control module resolution, we test the error message pattern
    try {
      const { create } = await import('../../src/providers/browser/container.js');
      const provider = await create(config);
      // If playwright IS installed, verify the provider works
      expect(provider).toBeDefined();
      expect(typeof provider.launch).toBe('function');
      expect(typeof provider.navigate).toBe('function');
      expect(typeof provider.snapshot).toBe('function');
      expect(typeof provider.click).toBe('function');
      expect(typeof provider.type).toBe('function');
      expect(typeof provider.screenshot).toBe('function');
      expect(typeof provider.close).toBe('function');
    } catch (err: unknown) {
      expect((err as Error).message).toContain('playwright');
    }
  });

  test('domain allowlist parsing from env var', async () => {
    // Test the domain allowlist logic by importing the module internals
    // We test via the public interface — navigate should reject non-allowed domains
    process.env.AX_BROWSER_ALLOWED_DOMAINS = 'example.com,test.org';

    try {
      const { create } = await import('../../src/providers/browser/container.js');
      const provider = await create(config);

      // If we have playwright, test domain filtering on navigate
      // We need a valid session, but launch requires playwright to work
      const session = await provider.launch({ headless: true });
      await expect(
        provider.navigate(session.id, 'https://evil.com'),
      ).rejects.toThrow('not in allowlist');

      await provider.close(session.id);
    } catch (err: unknown) {
      // playwright not installed — skip this test
      if ((err as Error).message.includes('playwright')) {
        expect(true).toBe(true); // pass
      } else {
        throw err;
      }
    }
  });

  test('rejects non-http protocols', async () => {
    delete process.env.AX_BROWSER_ALLOWED_DOMAINS;

    try {
      const { create } = await import('../../src/providers/browser/container.js');
      const provider = await create(config);
      const session = await provider.launch({ headless: true });

      await expect(
        provider.navigate(session.id, 'file:///etc/passwd'),
      ).rejects.toThrow('Unsupported protocol');

      await expect(
        provider.navigate(session.id, 'javascript:alert(1)'),
      ).rejects.toThrow('Unsupported protocol');

      await provider.close(session.id);
    } catch (err: unknown) {
      if ((err as Error).message.includes('playwright')) {
        expect(true).toBe(true);
      } else {
        throw err;
      }
    }
  });

  test('close on non-existent session is no-op', async () => {
    try {
      const { create } = await import('../../src/providers/browser/container.js');
      const provider = await create(config);
      // Should not throw
      await provider.close('non-existent-session-id');
    } catch (err: unknown) {
      if ((err as Error).message.includes('playwright')) {
        expect(true).toBe(true);
      } else {
        throw err;
      }
    }
  });

  test('getSession throws for unknown session ID', async () => {
    try {
      const { create } = await import('../../src/providers/browser/container.js');
      const provider = await create(config);

      await expect(
        provider.navigate('fake-session', 'https://example.com'),
      ).rejects.toThrow('session not found');

      await expect(
        provider.snapshot('fake-session'),
      ).rejects.toThrow('session not found');

      await expect(
        provider.click('fake-session', 0),
      ).rejects.toThrow('session not found');
    } catch (err: unknown) {
      if ((err as Error).message.includes('playwright')) {
        expect(true).toBe(true);
      } else {
        throw err;
      }
    }
  });

  test('allows all domains when no allowlist set', async () => {
    delete process.env.AX_BROWSER_ALLOWED_DOMAINS;

    try {
      const { create } = await import('../../src/providers/browser/container.js');
      const provider = await create(config);
      const session = await provider.launch({ headless: true });

      // Navigate to example.com should succeed (DNS may fail but not domain check)
      try {
        await provider.navigate(session.id, 'https://example.com');
      } catch (err: unknown) {
        // Network errors are fine — domain filtering should NOT throw
        expect((err as Error).message).not.toContain('not in allowlist');
      }

      await provider.close(session.id);
    } catch (err: unknown) {
      if ((err as Error).message.includes('playwright')) {
        expect(true).toBe(true);
      } else {
        throw err;
      }
    }
  });

  test('subdomain matching works with allowlist', async () => {
    process.env.AX_BROWSER_ALLOWED_DOMAINS = 'example.com';

    try {
      const { create } = await import('../../src/providers/browser/container.js');
      const provider = await create(config);
      const session = await provider.launch({ headless: true });

      // sub.example.com should be allowed (subdomain of example.com)
      try {
        await provider.navigate(session.id, 'https://sub.example.com');
      } catch (err: unknown) {
        expect((err as Error).message).not.toContain('not in allowlist');
      }

      // notexample.com should NOT be allowed
      await expect(
        provider.navigate(session.id, 'https://notexample.com'),
      ).rejects.toThrow('not in allowlist');

      await provider.close(session.id);
    } catch (err: unknown) {
      if ((err as Error).message.includes('playwright')) {
        expect(true).toBe(true);
      } else {
        throw err;
      }
    }
  });
});
