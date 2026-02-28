import { describe, test, expect, afterEach } from 'vitest';
import { isInteractive, isKeychainAvailable, hasDisplayServer } from '../../src/utils/interactive.js';

describe('isInteractive', () => {
  const saved = {
    AX_NON_INTERACTIVE: process.env.AX_NON_INTERACTIVE,
    CI: process.env.CI,
    isTTY: process.stdin.isTTY,
  };

  afterEach(() => {
    if (saved.AX_NON_INTERACTIVE !== undefined) {
      process.env.AX_NON_INTERACTIVE = saved.AX_NON_INTERACTIVE;
    } else {
      delete process.env.AX_NON_INTERACTIVE;
    }
    if (saved.CI !== undefined) {
      process.env.CI = saved.CI;
    } else {
      delete process.env.CI;
    }
    Object.defineProperty(process.stdin, 'isTTY', { value: saved.isTTY, writable: true, configurable: true });
  });

  test('returns false when AX_NON_INTERACTIVE=1', () => {
    process.env.AX_NON_INTERACTIVE = '1';
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    expect(isInteractive()).toBe(false);
  });

  test('returns false when AX_NON_INTERACTIVE=true', () => {
    process.env.AX_NON_INTERACTIVE = 'true';
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    expect(isInteractive()).toBe(false);
  });

  test('returns false when CI is set', () => {
    delete process.env.AX_NON_INTERACTIVE;
    process.env.CI = 'true';
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    expect(isInteractive()).toBe(false);
  });

  test('returns false when stdin is not TTY', () => {
    delete process.env.AX_NON_INTERACTIVE;
    delete process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });
    expect(isInteractive()).toBe(false);
  });

  test('returns true when stdin is TTY and no overrides', () => {
    delete process.env.AX_NON_INTERACTIVE;
    delete process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    expect(isInteractive()).toBe(true);
  });
});

describe('isKeychainAvailable', () => {
  const saved = {
    AX_NON_INTERACTIVE: process.env.AX_NON_INTERACTIVE,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    isTTY: process.stdin.isTTY,
    platform: process.platform,
  };

  afterEach(() => {
    if (saved.AX_NON_INTERACTIVE !== undefined) {
      process.env.AX_NON_INTERACTIVE = saved.AX_NON_INTERACTIVE;
    } else {
      delete process.env.AX_NON_INTERACTIVE;
    }
    if (saved.DISPLAY !== undefined) {
      process.env.DISPLAY = saved.DISPLAY;
    } else {
      delete process.env.DISPLAY;
    }
    if (saved.WAYLAND_DISPLAY !== undefined) {
      process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
    } else {
      delete process.env.WAYLAND_DISPLAY;
    }
    Object.defineProperty(process.stdin, 'isTTY', { value: saved.isTTY, writable: true, configurable: true });
    Object.defineProperty(process, 'platform', { value: saved.platform, writable: true, configurable: true });
  });

  test('returns false when AX_NON_INTERACTIVE=1 regardless of platform', () => {
    process.env.AX_NON_INTERACTIVE = '1';
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true, configurable: true });
    expect(isKeychainAvailable()).toBe(false);
  });

  test('returns false on Linux without DISPLAY or TTY', () => {
    delete process.env.AX_NON_INTERACTIVE;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });
    expect(isKeychainAvailable()).toBe(false);
  });

  test('returns true on Linux with DISPLAY set', () => {
    delete process.env.AX_NON_INTERACTIVE;
    process.env.DISPLAY = ':0';
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });
    expect(isKeychainAvailable()).toBe(true);
  });

  test('returns true on Linux with WAYLAND_DISPLAY set', () => {
    delete process.env.AX_NON_INTERACTIVE;
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });
    expect(isKeychainAvailable()).toBe(true);
  });

  test('returns true on Linux with stdin TTY', () => {
    delete process.env.AX_NON_INTERACTIVE;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    expect(isKeychainAvailable()).toBe(true);
  });

  test('returns true on macOS regardless of TTY or display', () => {
    delete process.env.AX_NON_INTERACTIVE;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });
    expect(isKeychainAvailable()).toBe(true);
  });
});

describe('hasDisplayServer', () => {
  const saved = {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    platform: process.platform,
  };

  afterEach(() => {
    if (saved.DISPLAY !== undefined) {
      process.env.DISPLAY = saved.DISPLAY;
    } else {
      delete process.env.DISPLAY;
    }
    if (saved.WAYLAND_DISPLAY !== undefined) {
      process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
    } else {
      delete process.env.WAYLAND_DISPLAY;
    }
    Object.defineProperty(process, 'platform', { value: saved.platform, writable: true, configurable: true });
  });

  test('returns true on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true, configurable: true });
    expect(hasDisplayServer()).toBe(true);
  });

  test('returns true on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: true, configurable: true });
    expect(hasDisplayServer()).toBe(true);
  });

  test('returns false on Linux without DISPLAY or WAYLAND_DISPLAY', () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
    expect(hasDisplayServer()).toBe(false);
  });

  test('returns true on Linux with DISPLAY', () => {
    process.env.DISPLAY = ':0';
    Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
    expect(hasDisplayServer()).toBe(true);
  });
});
