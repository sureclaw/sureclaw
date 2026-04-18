/**
 * MANIFEST.yaml auto-generator.
 *
 * Maps ParsedAgentSkill → GeneratedManifest. The bridge between the AgentSkills
 * open standard and AX's security model.
 *
 * Static analysis scans the SKILL.md body and code blocks for:
 *   - Known host commands (docker, gh, kubectl, npm, uv, python3, etc.)
 *   - Environment variable patterns (ALL_CAPS_KEY, --api-key flags)
 *   - Domain patterns from URLs
 *   - IPC tool references
 *   - Script paths (scripts/*.py, scripts/*.sh)
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ParsedAgentSkill, GeneratedManifest } from '../providers/skills/types.js';

// ═══════════════════════════════════════════════════════
// Known host commands to detect in body text
// ═══════════════════════════════════════════════════════

const KNOWN_COMMANDS = [
  'docker', 'docker-compose', 'gh', 'git', 'kubectl', 'helm',
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno',
  'uv', 'pip', 'python', 'python3',
  'cargo', 'go', 'make', 'cmake',
  'terraform', 'ansible', 'aws', 'gcloud', 'az',
  'ffmpeg', 'convert', 'jq', 'yq', 'curl', 'wget',
] as const;

const COMMAND_RE = new RegExp(
  `\\b(${KNOWN_COMMANDS.join('|')})\\s`,
  'g'
);

// ═══════════════════════════════════════════════════════
// Env var detection patterns
// ═══════════════════════════════════════════════════════

// Matches ALL_CAPS_WITH_UNDERSCORES that look like env vars (API keys, tokens, secrets)
const ENV_VAR_RE = /\b([A-Z][A-Z0-9_]{2,}(?:_(?:KEY|TOKEN|SECRET|API|PASSWORD|CREDENTIALS|AUTH))?)\b/g;

// Matches --api-key, --token, --secret-key style flags
const FLAG_RE = /--(?:api[_-]?key|token|secret[_-]?key|auth[_-]?token|password|credentials)\b/gi;

// Common false positives to exclude
const ENV_VAR_BLOCKLIST = new Set([
  'TODO', 'NOTE', 'IMPORTANT', 'WARNING', 'README', 'LICENSE',
  'HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS',
  'UTF', 'JSON', 'HTML', 'CSS', 'URL', 'URI', 'API',
  'AND', 'NOT', 'THE', 'FOR', 'WITH', 'USE',
  'YAML', 'TOML', 'SHELL', 'BASH',
]);

function looksLikeEnvVar(name: string): boolean {
  if (ENV_VAR_BLOCKLIST.has(name)) return false;
  if (name.length < 4) return false;
  // Must contain at least one underscore or end with KEY/TOKEN/SECRET etc.
  return name.includes('_') || /(?:KEY|TOKEN|SECRET|API|PASSWORD|AUTH)$/.test(name);
}

// ═══════════════════════════════════════════════════════
// URL / domain extraction
// ═══════════════════════════════════════════════════════

const URL_RE = /https?:\/\/([a-zA-Z0-9.-]+)/g;

// Bare domain references like "api.linear.app" or "api.linear.app/graphql" (no protocol prefix).
// Requires at least two dots (3+ segments) to avoid false positives on filenames like "config.yaml".
const BARE_DOMAIN_RE = /(?<![a-zA-Z0-9/:.-])([a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*){2,})\b/g;

// ═══════════════════════════════════════════════════════
// Script path detection
// ═══════════════════════════════════════════════════════

const SCRIPT_PATH_RE = /(?:scripts|bins?)\/[\w.-]+\.(?:py|sh|ts|js|rb|pl)\b/g;

// ═══════════════════════════════════════════════════════
// IPC tool references
// ═══════════════════════════════════════════════════════

const IPC_TOOLS = [
  'memory_write', 'memory_query', 'memory_read', 'memory_delete', 'memory_list',
  'web_fetch', 'web_search',
  'workspace_mount',
  'agent_delegate',
] as const;

function detectIpcTools(text: string): string[] {
  return IPC_TOOLS.filter(tool => text.includes(tool));
}

// ═══════════════════════════════════════════════════════
// Main generator
// ═══════════════════════════════════════════════════════

export function generateManifest(skill: ParsedAgentSkill): GeneratedManifest {
  const allText = skill.body + '\n' + skill.codeBlocks.join('\n');

  // --- Bins: from metadata + static analysis ---
  const binsFromMeta = new Set(skill.requires.bins);
  const hostCommands = new Set<string>();

  // Add bins from metadata
  for (const bin of binsFromMeta) {
    hostCommands.add(bin);
  }

  // Detect known commands in body text
  let match: RegExpExecArray | null;
  while ((match = COMMAND_RE.exec(allText)) !== null) {
    hostCommands.add(match[1]);
  }

  // --- Env vars: from metadata + static analysis ---
  const envFromMeta = new Set(skill.requires.env);
  const detectedEnv = new Set<string>(envFromMeta);

  while ((match = ENV_VAR_RE.exec(allText)) !== null) {
    if (looksLikeEnvVar(match[1])) {
      detectedEnv.add(match[1]);
    }
  }

  // Flag-style env hints (just note them, don't add as concrete env names)
  // This helps flag that env vars are needed even if the exact name isn't clear

  // --- Domains: from metadata + static analysis ---
  const domains = new Set<string>(skill.requires.domains);
  while ((match = URL_RE.exec(allText)) !== null) {
    domains.add(match[1]);
  }
  while ((match = BARE_DOMAIN_RE.exec(allText)) !== null) {
    domains.add(match[1]);
  }

  // --- IPC tools ---
  const tools = detectIpcTools(allText);

  // --- Script paths ---
  const scriptPaths = new Set<string>();
  while ((match = SCRIPT_PATH_RE.exec(allText)) !== null) {
    scriptPaths.add(match[0]);
  }

  // --- Permissions from frontmatter ---
  const toolsFromPerms = new Set(tools);
  for (const perm of skill.permissions) {
    toolsFromPerms.add(perm);
  }

  // --- Install steps ---
  const installSteps = skill.install.map(spec => ({
    run: spec.run,
    label: spec.label,
    bin: spec.bin,
    os: spec.os,
    approval: 'required' as const,
  }));

  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    requires: {
      bins: [...binsFromMeta],
      env: [...detectedEnv],
      os: skill.os,
    },
    capabilities: {
      tools: [...toolsFromPerms],
      host_commands: [...hostCommands],
      domains: [...domains],
    },
    install: {
      steps: installSteps,
    },
    executables: [...scriptPaths].map(path => ({ path })),
  };
}

/**
 * Hash executable files (if they exist on disk) and add SHA-256 to manifest.
 * Call after generateManifest() when the skill directory is available locally.
 */
export async function hashExecutables(
  manifest: GeneratedManifest,
  skillDir: string,
): Promise<GeneratedManifest> {
  const updated = { ...manifest, executables: [...manifest.executables] };

  for (let i = 0; i < updated.executables.length; i++) {
    const entry = updated.executables[i];
    const fullPath = resolve(join(skillDir, entry.path));
    try {
      const content = await readFile(fullPath);
      const sha256 = createHash('sha256').update(content).digest('hex');
      updated.executables[i] = { ...entry, sha256 };
    } catch {
      // File not available — leave sha256 undefined
    }
  }

  return updated;
}
