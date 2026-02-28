/**
 * Promise timeout utility — wraps any promise with a deadline.
 *
 * If the promise doesn't resolve/reject before the timeout, a
 * TimeoutError is thrown. The original promise continues running
 * (there's no way to cancel a native Promise), but the caller
 * is unblocked.
 *
 * This is the canonical defense against third-party calls that
 * can hang indefinitely (keytar, D-Bus, external processes).
 */

export class TimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.operation = operation;
  }
}

/**
 * Race a promise against a timeout.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param operation - Human-readable label for error messages
 * @returns The resolved value if the promise completes in time
 * @throws TimeoutError if the deadline is exceeded
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new TimeoutError(operation, timeoutMs)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
