/**
 * Creates a stub provider where every method throws "Provider disabled".
 * Used by "none" providers (web/none, etc.) to satisfy the interface
 * without implementing any real logic.
 */
export function disabledProvider<T extends object>(): T {
  return new Proxy({} as T, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined; // not a thenable
      return () => { throw new Error('Provider disabled (provider: none)'); };
    },
  });
}
