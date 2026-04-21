/**
 * Shared URL rewrite helper.
 *
 * Originally lived inside `src/host/web-proxy.ts` as a closure, used only for
 * sandbox outbound traffic. Promoted here so the MCP client (which runs on
 * the host and bypasses the sandbox proxy) can apply the same
 * `config.url_rewrites` map when contacting external MCP servers.
 *
 * Why this matters for tests: the e2e harness in `tests/e2e/global-setup.ts`
 * sets `url_rewrites: { 'api.linear.app': mockBaseUrl, 'mock-target.test':
 * mockBaseUrl }` so a skill's `https://mock-target.test/mcp/linear`
 * frontmatter URL transparently routes to the mock server. Without this
 * helper wired into MCP dispatch, the host would attempt real DNS for
 * `mock-target.test` and fail.
 *
 * Why not in production: `config.url_rewrites` is undefined in the default
 * config, so `applyUrlRewrite` is a no-op pass-through in production.
 */

export type UrlRewriteMap = Record<string, string>;

/**
 * Apply a hostname → base-URL rewrite to `originalUrl`. Returns the original
 * URL unchanged if no rule matches (including when `rewrites` is undefined
 * or empty, or when `originalUrl` is not a parseable URL).
 *
 * Semantics:
 *   - Matches by exact lowercased hostname. No wildcards (the existing
 *     web-proxy behavior).
 *   - Preserves the original URL's pathname and query string; appends them
 *     to the replacement's origin + pathname prefix.
 *   - A replacement base of `http://0.0.0.0:1234` means "same path, new
 *     origin"; a replacement of `http://0.0.0.0:1234/prefix` prepends
 *     `/prefix` to the original path.
 */
export function applyUrlRewrite(
  originalUrl: string,
  rewrites: UrlRewriteMap | Map<string, string> | undefined,
): string {
  if (!rewrites) return originalUrl;
  const map = rewrites instanceof Map ? rewrites : new Map(Object.entries(rewrites));
  if (map.size === 0) return originalUrl;

  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return originalUrl;
  }

  const replacement = map.get(parsed.hostname.toLowerCase());
  if (!replacement) return originalUrl;

  let target: URL;
  try {
    target = new URL(replacement);
  } catch {
    return originalUrl;
  }

  const basePath = target.pathname === '/' ? '' : target.pathname;
  return `${target.origin}${basePath}${parsed.pathname}${parsed.search}`;
}
