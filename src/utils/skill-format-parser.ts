/**
 * AgentSkills format parser.
 *
 * Parses SKILL.md files (open standard + OpenClaw/Clawdbot extensions) into
 * a normalized ParsedAgentSkill. Handles:
 *   - Standard fields: name, description, version, license, homepage
 *   - Nested metadata: metadata.openclaw (or .clawdbot / .clawdis aliases)
 *   - Install specs: brew (formula), node/go/uv (package)
 *   - Flat legacy: permissions, triggers, tags
 *   - Code block extraction from markdown body
 *   - Graceful handling of minimal frontmatter (no metadata block)
 */

import { parse as parseYaml } from 'yaml';
import type { ParsedAgentSkill, SkillInstallStep, OAuthRequirement } from '../providers/skills/types.js';

// ═══════════════════════════════════════════════════════
// Frontmatter extraction
// ═══════════════════════════════════════════════════════

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function extractFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  try {
    const parsed = parseYaml(match[1]);
    return {
      frontmatter: (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {},
      body: raw.slice(match[0].length).trimStart(),
    };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

// ═══════════════════════════════════════════════════════
// Code block extraction
// ═══════════════════════════════════════════════════════

const CODE_BLOCK_RE = /```[\w-]*\r?\n([\s\S]*?)```/g;

function extractCodeBlocks(body: string): string[] {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CODE_BLOCK_RE.exec(body)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

// ═══════════════════════════════════════════════════════
// Metadata resolution (aliases: openclaw, clawdbot, clawdis)
// ═══════════════════════════════════════════════════════

const METADATA_ALIASES = ['openclaw', 'clawdbot', 'clawdis'] as const;

function resolveMetadata(fm: Record<string, unknown>): Record<string, unknown> | null {
  const meta = fm.metadata;
  if (!meta || typeof meta !== 'object') return null;

  const metaObj = meta as Record<string, unknown>;
  for (const alias of METADATA_ALIASES) {
    if (metaObj[alias] && typeof metaObj[alias] === 'object') {
      return metaObj[alias] as Record<string, unknown>;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════
// Install step normalization
// ═══════════════════════════════════════════════════════

// Backward-compat: old kind/package → new run command
const KIND_TO_RUN: Record<string, (pkg: string) => string> = {
  brew:   pkg => `brew install ${pkg}`,
  node:   pkg => `npm install -g ${pkg}`,
  npm:    pkg => `npm install -g ${pkg}`,
  pip:    pkg => `pip install --user ${pkg}`,
  go:     pkg => `go install ${pkg}@latest`,
  cargo:  pkg => `cargo install ${pkg}`,
  uv:     pkg => `uv tool install ${pkg}`,
};

function parseInstallSteps(raw: unknown): SkillInstallStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map(item => {
      // New format: has `run` field
      if (typeof item.run === 'string') {
        return {
          run: item.run,
          label: typeof item.label === 'string' ? item.label : undefined,
          bin: typeof item.bin === 'string' ? item.bin : undefined,
          os: Array.isArray(item.os) ? item.os.map(String) : undefined,
        };
      }

      // Old format: kind/package/formula/bins → convert to new format
      const kind = String(item.kind ?? 'unknown');
      const pkg = String(item.formula ?? item.package ?? '');
      const bins = Array.isArray(item.bins) ? item.bins.map(String) : undefined;
      const converter = KIND_TO_RUN[kind];
      const run = converter ? converter(pkg) : `${kind} install ${pkg}`;

      return {
        run,
        label: typeof item.label === 'string' ? item.label : undefined,
        bin: bins?.[0],  // First binary as representative check
        os: Array.isArray(item.os) ? item.os.map(String) : undefined,
      };
    });
}

// ═══════════════════════════════════════════════════════
// Permission mapping: OpenClaw terms → AX IPC actions
// ═══════════════════════════════════════════════════════

const PERMISSION_MAP: Record<string, string> = {
  'full-disk-access': 'workspace_mount',
  'disk-full-access': 'workspace_mount',
  'read-files': 'workspace_mount',
  'write-files': 'workspace_mount',
  'web-access': 'web_fetch',
  'web-search': 'web_search',
  'run-commands': 'agent_delegate',
  'exec': 'agent_delegate',
};

function mapPermissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(p => {
    const str = String(p);
    return PERMISSION_MAP[str] ?? str;
  });
}

// ═══════════════════════════════════════════════════════
// Main parser
// ═══════════════════════════════════════════════════════

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

function toOAuthRequirements(raw: unknown): OAuthRequirement[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object'
      && typeof (item as any).name === 'string'
      && typeof (item as any).authorize_url === 'string'
      && typeof (item as any).token_url === 'string'
      && typeof (item as any).client_id === 'string')
    .map(item => ({
      name: String(item.name),
      authorize_url: String(item.authorize_url),
      token_url: String(item.token_url),
      scopes: toStringArray(item.scopes),
      client_id: String(item.client_id),
      ...(typeof item.client_secret_env === 'string' ? { client_secret_env: item.client_secret_env } : {}),
    }));
}

export function parseAgentSkill(raw: string): ParsedAgentSkill {
  const { frontmatter: fm, body } = extractFrontmatter(raw);
  const meta = resolveMetadata(fm);

  // Extract requires from metadata (if present)
  const requires = meta?.requires as Record<string, unknown> | undefined;

  // Extract code blocks from the body
  const codeBlocks = extractCodeBlocks(body);

  return {
    name: String(fm.name ?? ''),
    description: typeof fm.description === 'string' ? fm.description : undefined,
    version: typeof fm.version === 'string' ? fm.version : undefined,
    license: typeof fm.license === 'string' ? fm.license : undefined,
    homepage: typeof fm.homepage === 'string' ? fm.homepage : undefined,

    requires: {
      bins: toStringArray(requires?.bins),
      env: toStringArray(requires?.env),
      oauth: toOAuthRequirements(requires?.oauth),
      anyBins: Array.isArray(requires?.anyBins)
        ? (requires.anyBins as unknown[]).filter(Array.isArray).map(a => a.map(String))
        : undefined,
      config: (requires?.config && typeof requires.config === 'object')
        ? Object.fromEntries(
            Object.entries(requires.config as Record<string, unknown>).map(([k, v]) => [k, String(v)])
          )
        : undefined,
    },

    install: parseInstallSteps(meta?.install),
    os: Array.isArray(meta?.os) ? (meta.os as unknown[]).map(String) : undefined,

    // Flat legacy fields
    permissions: mapPermissions(fm.permissions),
    triggers: Array.isArray(fm.triggers) ? (fm.triggers as unknown[]).map(String) : undefined,
    tags: Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String) : undefined,

    body,
    codeBlocks,
  };
}
