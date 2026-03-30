/**
 * Skill CRUD operations for database-stored skills (fast-path model).
 *
 * Skills stored via DocumentStore in the 'skills' collection.
 * Agent-scoped key format: '{agentId}/{skillSlug}'
 * User-scoped key format:  '{agentId}/users/{userId}/{skillSlug}'
 * Value: JSON { instructions, mcpApps, mcpTools, authType, version, installedAt, scope?, userId? }
 */

import type { DocumentStore } from './types.js';

export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillRecord {
  id: string;
  agentId: string;
  version: string;
  instructions: string;
  files: SkillFile[];
  mcpApps: string[];
  mcpTools: string[] | null;
  authType: 'oauth' | 'api_key' | null;
  installedAt: string;
  /** 'agent' = shared (plugins/admin), 'user' = personal sandbox skill. */
  scope?: 'agent' | 'user';
  /** Set when scope is 'user'. */
  userId?: string;
}

export interface SkillUpsertInput {
  id: string;
  agentId: string;
  version: string;
  instructions: string;
  files?: SkillFile[];
  mcpApps: string[];
  mcpTools?: string[] | null;
  authType?: 'oauth' | 'api_key' | null;
  scope?: 'agent' | 'user';
  userId?: string;
}

function skillKey(agentId: string, skillId: string): string {
  return `${agentId}/${skillId}`;
}

function userSkillKey(agentId: string, userId: string, skillId: string): string {
  return `${agentId}/users/${userId}/${skillId}`;
}

export async function upsertSkill(
  documents: DocumentStore,
  input: SkillUpsertInput,
): Promise<void> {
  const record: SkillRecord = {
    id: input.id,
    agentId: input.agentId,
    version: input.version,
    instructions: input.instructions,
    files: input.files ?? [{ path: 'SKILL.md', content: input.instructions }],
    mcpApps: input.mcpApps,
    mcpTools: input.mcpTools ?? null,
    authType: input.authType ?? null,
    installedAt: new Date().toISOString(),
    scope: input.scope ?? 'agent',
    userId: input.userId,
  };
  const key = input.scope === 'user' && input.userId
    ? userSkillKey(input.agentId, input.userId, input.id)
    : skillKey(input.agentId, input.id);
  await documents.put('skills', key, JSON.stringify(record));
}

export async function getSkill(
  documents: DocumentStore,
  agentId: string,
  skillId: string,
  userId?: string,
): Promise<SkillRecord | null> {
  // Try user-scoped first if userId provided, then fall back to agent-scoped
  if (userId) {
    const userRaw = await documents.get('skills', userSkillKey(agentId, userId, skillId));
    if (userRaw) {
      try { return JSON.parse(userRaw) as SkillRecord; } catch { /* fall through */ }
    }
  }
  const raw = await documents.get('skills', skillKey(agentId, skillId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkillRecord;
  } catch {
    return null;
  }
}

/** List agent-scoped skills (excludes user-scoped). N+1 fetch pattern —
 *  acceptable for typical skill counts (<100). */
export async function listSkills(
  documents: DocumentStore,
  agentId: string,
): Promise<SkillRecord[]> {
  const keys = await documents.list('skills');
  const prefix = `${agentId}/`;
  const userPrefix = `${agentId}/users/`;
  const skills: SkillRecord[] = [];

  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    // Skip user-scoped skills — those are returned by listUserSkills()
    if (key.startsWith(userPrefix)) continue;
    const raw = await documents.get('skills', key);
    if (!raw) continue;
    try {
      skills.push(JSON.parse(raw) as SkillRecord);
    } catch {
      // Malformed — skip
    }
  }

  return skills;
}

/** List user-scoped skills for a specific user. */
export async function listUserSkills(
  documents: DocumentStore,
  agentId: string,
  userId: string,
): Promise<SkillRecord[]> {
  const keys = await documents.list('skills');
  const prefix = `${agentId}/users/${userId}/`;
  const skills: SkillRecord[] = [];

  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const raw = await documents.get('skills', key);
    if (!raw) continue;
    try {
      skills.push(JSON.parse(raw) as SkillRecord);
    } catch {
      // Malformed — skip
    }
  }

  return skills;
}

export async function deleteSkill(
  documents: DocumentStore,
  agentId: string,
  skillId: string,
  userId?: string,
): Promise<boolean> {
  // Try user-scoped first if userId provided
  if (userId) {
    const deleted = await documents.delete('skills', userSkillKey(agentId, userId, skillId));
    if (deleted) return true;
  }
  return documents.delete('skills', skillKey(agentId, skillId));
}

/**
 * Infer MCP app names from a skill's instructions/metadata.
 *
 * Best-effort heuristic — may produce false positives for generic patterns
 * like "data_get_something". The length check (>3) and exclusion list filter
 * out common English words but cannot eliminate all ambiguity. Acceptable
 * since the result is used for tool discovery hints, not access control.
 */
export function inferMcpApps(instructions: string): string[] {
  const apps = new Set<string>();

  // Heuristic: tool names like "google_slides_custom_api_call" -> "google-slides"
  const toolPattern = /(\w+)_custom_api_call/g;
  let match;
  while ((match = toolPattern.exec(instructions)) !== null) {
    apps.add(match[1].replace(/_/g, '-'));
  }

  // Heuristic: "google_slides_get_*" tool references -> "google-slides"
  const appToolPattern = /(\w+)_(?:get|create|update|delete|list|search|send|read|write)\w*/g;
  while ((match = appToolPattern.exec(instructions)) !== null) {
    const candidate = match[1].replace(/_/g, '-');
    if (candidate.length > 3 && !['the', 'and', 'for', 'use', 'you'].includes(candidate)) {
      apps.add(candidate);
    }
  }

  return [...apps];
}
