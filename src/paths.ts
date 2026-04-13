/**
 * Centralized path resolution for AX.
 *
 * All config and data files live under ~/.ax/ by default.
 * Override with AX_HOME env var (useful for tests).
 *
 * Layout:
 *   ~/.ax/
 *     ax.yaml           — main config
 *     .env              — API keys
 *     registry.json     — agent registry (enterprise)
 *     data/
 *       ax.db           — shared SQLite database (messages, conversations, sessions, documents, audit)
 *       memory.db       — SQLite memory provider
 *       memory/         — file memory provider
 *     agents/
 *       <agent-id>/
 *         admins              — admin access control (top-level, NOT in sandbox)
 *         .bootstrap-admin-claimed — bootstrap state (top-level, NOT in sandbox)
 *         agent/              — agent config dir (NOT directly mounted)
 *           BOOTSTRAP.md      — bootstrap detection (server-side checks)
 *           USER_BOOTSTRAP.md — first-contact prompt
 *           capabilities.yaml — capability declarations
 *           identity/         — → /workspace/identity (ro mount in sandbox)
 *             AGENTS.md       — operating instructions
 *             SOUL.md         — personality, tone, boundaries
 *             IDENTITY.md     — name, role, capabilities
 *             HEARTBEAT.md    — scheduled task checklist
 *             BOOTSTRAP.md    — copy for agent-side reading
 *             USER_BOOTSTRAP.md — copy for agent-side reading
 *           workspace/        — shared code, docs
 *             repo/
 *             docs/
 *           skills/           — agent-level skills (shared across users)
 *         users/
 *           <userId>/         — per-user state (isolated per user)
 *             USER.md         — user preferences, style, context
 *             workspace/      — user's persistent files
 *             skills/         — user-level skills (private to this user)
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { safePath } from './utils/safe-path.js';

/** Root directory for all AX files. */
export function axHome(): string {
  return process.env.AX_HOME || join(homedir(), '.ax');
}

/** Path to ax.yaml config file. Override with AX_CONFIG_PATH env var. */
export function configPath(): string {
  return process.env.AX_CONFIG_PATH || join(axHome(), 'ax.yaml');
}

/** Path to .env file. */
export function envPath(): string {
  return join(axHome(), '.env');
}


/** Path to the data subdirectory. */
export function dataDir(): string {
  return join(axHome(), 'data');
}

/** Resolve a file path under the data directory. */
export function dataFile(...segments: string[]): string {
  return join(dataDir(), ...segments);
}

/** UUID format regex (same as ipc-schemas.ts line 24). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Valid segment: alphanumeric, underscore, hyphen, dot — all filesystem-safe. */
const SEGMENT_RE = /^[a-zA-Z0-9_.@\-]+$/;

/**
 * Validate that a string is a valid session ID.
 * Accepts either a lowercase UUID or 3+ colon-separated segments
 * where each segment matches SEGMENT_RE.
 */
export function isValidSessionId(id: string): boolean {
  if (UUID_RE.test(id)) return true;
  if (!id.includes(':')) return false;
  const parts = id.split(':');
  if (parts.length < 3) return false;
  return parts.every(p => p.length > 0 && SEGMENT_RE.test(p));
}

/** Compose a session ID from parts, joining with ':'. Validates each segment. */
export function composeSessionId(...parts: string[]): string {
  if (parts.length < 3) {
    throw new Error('Session ID requires at least 3 segments');
  }
  for (const p of parts) {
    if (!p || !SEGMENT_RE.test(p)) {
      throw new Error(`Invalid session ID segment: "${p}"`);
    }
  }
  return parts.join(':');
}

/** Parse a session ID into segments. Returns array for colon-format, null for UUIDs. */
export function parseSessionId(id: string): string[] | null {
  if (UUID_RE.test(id)) return null;
  if (!id.includes(':')) return null;
  const parts = id.split(':');
  if (parts.length < 3) return null;
  if (!parts.every(p => p.length > 0 && SEGMENT_RE.test(p))) return null;
  return parts;
}

const SAFE_NAME_RE = /^[a-zA-Z0-9_.@-]+$/;

function validatePathSegment(value: string, label: string): void {
  if (!value || !SAFE_NAME_RE.test(value)) {
    throw new Error(`Invalid ${label}: must be alphanumeric, dash, underscore, dot, or @, got "${value}"`);
  }
}

/** Path to an agent's directory: ~/.ax/agents/<name>/ */
export function agentDir(agentName: string): string {
  validatePathSegment(agentName, 'agent name');
  return join(axHome(), 'agents', agentName);
}

/** @deprecated Use agentDir instead. */
export const agentStateDir = agentDir;

/** Path to a per-user directory within an agent's state: ~/.ax/agents/<name>/users/<userId>/ */
export function agentUserDir(agentName: string, userId: string): string {
  validatePathSegment(agentName, 'agent name');
  validatePathSegment(userId, 'userId');
  return join(agentDir(agentName), 'users', userId);
}

// ═══════════════════════════════════════════════════════
// Enterprise Agent Architecture — multi-agent paths
// ═══════════════════════════════════════════════════════

/**
 * Path to an agent's config directory:
 * ~/.ax/agents/<agentId>/agent/
 *
 * @deprecated Identity files are now stored in DocumentStore and sent via stdin payload.
 * This path helper remains for governance handler backward compatibility only.
 */
export function agentIdentityDir(agentId: string): string {
  validatePathSegment(agentId, 'agent ID');
  return join(axHome(), 'agents', agentId, 'agent');
}

/**
 * Path to an agent's identity files directory:
 * ~/.ax/agents/<agentId>/agent/identity/
 *
 * @deprecated Identity files are now stored in DocumentStore and sent via stdin payload.
 * This path helper remains for governance handler backward compatibility only.
 */
export function agentIdentityFilesDir(agentId: string): string {
  return join(agentIdentityDir(agentId), 'identity');
}

/**
 * @deprecated No longer used — single workspace model (/workspace in sandbox).
 * Path to an agent's shared workspace: ~/.ax/agents/<agentId>/agent/workspace/
 */
export function agentWorkspaceDir(agentId: string): string {
  return join(agentIdentityDir(agentId), 'workspace');
}

/**
 * @deprecated Skills are now stored in DocumentStore and sent via stdin payload.
 * Path to an agent's skills directory (agent-level, shared): ~/.ax/agents/<agentId>/agent/skills/
 */
export function agentSkillsDir(agentId: string): string {
  return join(agentIdentityDir(agentId), 'skills');
}

/**
 * @deprecated Skills are now stored in DocumentStore and sent via stdin payload.
 * Path to a user's skills directory (user-level, private):
 * ~/.ax/agents/<agentId>/users/<userId>/skills/
 */
export function userSkillsDir(agentId: string, userId: string): string {
  validatePathSegment(agentId, 'agent ID');
  validatePathSegment(userId, 'userId');
  return join(axHome(), 'agents', agentId, 'users', userId, 'skills');
}

/**
 * @deprecated No longer used — single workspace model (/workspace in sandbox).
 * Path to a user's workspace within an agent:
 * ~/.ax/agents/<agentId>/users/<userId>/workspace/
 */
export function userWorkspaceDir(agentId: string, userId: string): string {
  validatePathSegment(agentId, 'agent ID');
  validatePathSegment(userId, 'userId');
  return join(axHome(), 'agents', agentId, 'users', userId, 'workspace');
}

/** Path to the agent registry file: ~/.ax/registry.json */
export function registryPath(): string {
  return join(axHome(), 'registry.json');
}

/** Path to the proposals directory for governance: ~/.ax/data/proposals/ */
export function proposalsDir(): string {
  return join(dataDir(), 'proposals');
}

/** Directory for webhook transform files: ~/.ax/webhooks/ */
export function webhooksDir(): string {
  return join(axHome(), 'webhooks');
}

/** Path to a specific webhook transform file: ~/.ax/webhooks/<name>.md */
export function webhookTransformPath(name: string): string {
  return safePath(webhooksDir(), `${name}.md`);
}
