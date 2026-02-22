import { describe, test, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  exitCodePromise,
  enforceTimeout,
  killProcess,
  checkCommand,
  sandboxProcess,
} from '../../../src/providers/sandbox/utils.js';

describe('sandbox/utils', () => {
  describe('exitCodePromise', () => {
    test('resolves with exit code on normal exit', async () => {
      const child = spawn('true');
      const code = await exitCodePromise(child);
      expect(code).toBe(0);
    });

    test('resolves with non-zero exit code on failure', async () => {
      const child = spawn('false');
      const code = await exitCodePromise(child);
      expect(code).not.toBe(0);
    });

    test('resolves with 1 when exit code is null', async () => {
      const child = spawn('sleep', ['60']);
      child.kill('SIGKILL');
      const code = await exitCodePromise(child);
      expect(code).not.toBe(0);
    });
  });

  describe('enforceTimeout', () => {
    test('kills process after timeout', async () => {
      const child = spawn('sleep', ['60']);
      enforceTimeout(child, 1);
      const code = await exitCodePromise(child);
      expect(code).not.toBe(0);
    }, 5000);

    test('does nothing when timeoutSec is undefined', async () => {
      const child = spawn('echo', ['hi']);
      enforceTimeout(child, undefined);
      const code = await exitCodePromise(child);
      expect(code).toBe(0);
    });

    test('sends SIGTERM at timeout, then SIGKILL after grace period', async () => {
      vi.useFakeTimers();
      const child = spawn('sleep', ['60']);
      const killSpy = vi.spyOn(child, 'kill');
      enforceTimeout(child, 10, 5);
      // Should not have signaled yet before timeout
      vi.advanceTimersByTime(9_999);
      expect(killSpy).not.toHaveBeenCalled();
      // At 10s, should send SIGTERM (first call)
      vi.advanceTimersByTime(1);
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenNthCalledWith(1, 'SIGTERM');
      // With fake timers the child's 'exit' event won't fire synchronously,
      // so SIGKILL should follow at 10s + 5s grace
      vi.advanceTimersByTime(5_000);
      expect(killSpy).toHaveBeenCalledTimes(2);
      expect(killSpy).toHaveBeenNthCalledWith(2, 'SIGKILL');
      vi.useRealTimers();
      // Clean up
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      await exitCodePromise(child);
    });
  });

  describe('killProcess', () => {
    test('kills a running process', async () => {
      const child = spawn('sleep', ['60']);
      const pid = child.pid!;
      await killProcess(pid);
      const code = await exitCodePromise(child);
      expect(code).not.toBe(0);
    });

    test('does not throw for non-existent pid', async () => {
      await expect(killProcess(999999)).resolves.toBeUndefined();
    });
  });

  describe('checkCommand', () => {
    test('returns true for available command', async () => {
      expect(await checkCommand('echo', ['hi'])).toBe(true);
    });

    test('returns false for unavailable command', async () => {
      expect(await checkCommand('nonexistent-command-xyz')).toBe(false);
    });
  });

  describe('sandboxProcess', () => {
    test('returns SandboxProcess shape from ChildProcess', async () => {
      const child = spawn('echo', ['hello']);
      const exitCode = exitCodePromise(child);
      const proc = sandboxProcess(child, exitCode);

      expect(proc.pid).toBeGreaterThan(0);
      expect(proc.stdout).toBe(child.stdout);
      expect(proc.stderr).toBe(child.stderr);
      expect(proc.stdin).toBe(child.stdin);
      expect(typeof proc.kill).toBe('function');

      const code = await proc.exitCode;
      expect(code).toBe(0);
    });

    test('kill delegates to child.kill', async () => {
      const child = spawn('sleep', ['60']);
      const exitCode = exitCodePromise(child);
      const proc = sandboxProcess(child, exitCode);

      proc.kill();
      const code = await proc.exitCode;
      expect(code).not.toBe(0);
    });
  });
});
