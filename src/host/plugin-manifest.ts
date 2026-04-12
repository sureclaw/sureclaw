/**
 * Plugin Manifest — schema definition and validation for AX plugins.
 *
 * Every third-party plugin must include a MANIFEST.json that declares:
 *   - Which provider kind/name it implements
 *   - What capabilities it needs (network, filesystem, credentials)
 *   - Its integrity hash for tamper detection
 *
 * SECURITY: The manifest is the trust boundary. Capabilities declared here
 * are enforced by the PluginHost — they are NOT advisory. If a plugin tries
 * to access a network host not in its manifest, the request is blocked.
 *
 * We deliberately don't support:
 *   - Wildcard network access ("*")
 *   - Filesystem write without explicit declaration
 *   - Credential access beyond declared keys
 */

import { z } from 'zod';

// ═══════════════════════════════════════════════════════
// Manifest Schema
// ═══════════════════════════════════════════════════════

/** Safe string validator (no null bytes). */
const safeStr = (max: number) =>
  z.string().max(max).check(
    z.refine((s: string) => !s.includes('\0'), 'Null bytes not allowed')
  );

/** Network endpoint: host:port format. */
const networkEndpoint = z.string().regex(
  /^[a-zA-Z0-9._-]+:\d{1,5}$/,
  'Must be host:port format (e.g., localhost:5432)',
);

/** Valid provider kinds. */
const PLUGIN_PROVIDER_KINDS = [
  'llm', 'memory', 'security', 'channel',
  'web', 'credentials', 'skills',
  'audit', 'sandbox', 'scheduler',
] as const;

export const PluginManifestSchema = z.strictObject({
  /** npm package name (scoped). */
  name: safeStr(214),

  /** Provider registration info. */
  ax_provider: z.strictObject({
    /** Provider category (e.g., 'memory', 'llm'). */
    kind: z.enum(PLUGIN_PROVIDER_KINDS),
    /** Provider name within category (e.g., 'postgres'). */
    name: safeStr(64).regex(
      /^[a-z][a-z0-9_-]{0,63}$/,
      'Must be lowercase alphanumeric with hyphens/underscores',
    ),
  }),

  /** Capability declarations — enforced, not advisory. */
  capabilities: z.strictObject({
    /**
     * Network endpoints the plugin needs access to.
     * Empty array = no network access (default).
     * Each entry is a "host:port" string.
     */
    network: z.array(networkEndpoint).max(20).default([]),

    /**
     * Filesystem access level.
     *   - 'none': No filesystem access (default, safest)
     *   - 'read':  Read-only within plugin's data directory
     *   - 'write': Read-write within plugin's data directory
     */
    filesystem: z.enum(['none', 'read', 'write']).default('none'),

    /**
     * Credential keys the plugin needs injected by the host.
     * These are injected server-side — the plugin process never
     * sees the raw credential store.
     */
    credentials: z.array(safeStr(128)).max(20).default([]),
  }),

  /** SHA-512 integrity hash of the package tarball. */
  integrity: safeStr(256).regex(
    /^sha512-[A-Za-z0-9+/=]+$/,
    'Must be sha512-<base64> format',
  ).optional(),

  /** Human-readable description. */
  description: safeStr(500).optional(),

  /** Package version (semver). */
  version: safeStr(32).optional(),

  /** Plugin entry point relative to package root. Defaults to 'index.js'. */
  main: safeStr(256).default('index.js'),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ═══════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════

export interface ManifestValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors?: string[];
}

/**
 * Parse and validate a plugin manifest from raw JSON.
 * Returns structured errors instead of throwing.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const result = PluginManifestSchema.safeParse(raw);

  if (result.success) {
    return { valid: true, manifest: result.data };
  }

  const errors = result.error.issues.map(issue => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return { valid: false, errors };
}

/**
 * Format a manifest for human review (printed to stdout during `ax plugin add`).
 */
export function formatManifestForReview(manifest: PluginManifest): string {
  const lines: string[] = [];

  lines.push(`Plugin: ${manifest.name}`);
  if (manifest.description) lines.push(`Description: ${manifest.description}`);
  if (manifest.version) lines.push(`Version: ${manifest.version}`);
  lines.push(`Provider: ${manifest.ax_provider.kind}/${manifest.ax_provider.name}`);
  lines.push('');
  lines.push('Capabilities:');

  const caps = manifest.capabilities;
  if (caps.network.length > 0) {
    lines.push(`  Network: ${caps.network.join(', ')}`);
  } else {
    lines.push('  Network: none (no outbound connections)');
  }

  lines.push(`  Filesystem: ${caps.filesystem}`);

  if (caps.credentials.length > 0) {
    lines.push(`  Credentials: ${caps.credentials.join(', ')}`);
  } else {
    lines.push('  Credentials: none');
  }

  if (manifest.integrity) {
    lines.push('');
    lines.push(`Integrity: ${manifest.integrity}`);
  }

  return lines.join('\n');
}
