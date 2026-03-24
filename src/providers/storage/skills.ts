/**
 * Skill CRUD operations for database-stored skills (fast-path model).
 *
 * Skills stored via DocumentStore in the 'skills' collection.
 * Key format: '{agentId}/{skillSlug}'
 * Value: JSON { instructions, mcpApps, mcpTools, authType, version, installedAt }
 */

import type { DocumentStore } from './types.js';

export interface SkillRecord {
  id: string;
  agentId: string;
  version: string;
  instructions: string;
  mcpApps: string[];
  mcpTools: string[] | null;
  authType: 'oauth' | 'api_key' | null;
  installedAt: string;
}

export interface SkillUpsertInput {
  id: string;
  agentId: string;
  version: string;
  instructions: string;
  mcpApps: string[];
  mcpTools?: string[] | null;
  authType?: 'oauth' | 'api_key' | null;
}

function skillKey(agentId: string, skillId: string): string {
  return `${agentId}/${skillId}`;
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
    mcpApps: input.mcpApps,
    mcpTools: input.mcpTools ?? null,
    authType: input.authType ?? null,
    installedAt: new Date().toISOString(),
  };
  await documents.put('skills', skillKey(input.agentId, input.id), JSON.stringify(record));
}

export async function getSkill(
  documents: DocumentStore,
  agentId: string,
  skillId: string,
): Promise<SkillRecord | null> {
  const raw = await documents.get('skills', skillKey(agentId, skillId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkillRecord;
  } catch {
    return null;
  }
}

export async function listSkills(
  documents: DocumentStore,
  agentId: string,
): Promise<SkillRecord[]> {
  const keys = await documents.list('skills');
  const prefix = `${agentId}/`;
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
): Promise<boolean> {
  return documents.delete('skills', skillKey(agentId, skillId));
}

/**
 * Infer MCP app names from a skill's instructions/metadata.
 * Heuristic: looks for known patterns like "google_slides_custom_api_call" -> "google-slides".
 */
export function inferMcpApps(instructions: string): string[] {
  const apps = new Set<string>();

  // Pattern: tool names like "google_slides_custom_api_call" -> "google-slides"
  const toolPattern = /(\w+)_custom_api_call/g;
  let match;
  while ((match = toolPattern.exec(instructions)) !== null) {
    apps.add(match[1].replace(/_/g, '-'));
  }

  // Pattern: "google_slides_*" tool references -> "google-slides"
  const appToolPattern = /(\w+)_(?:get|create|update|delete|list|search|send|read|write)\w*/g;
  while ((match = appToolPattern.exec(instructions)) !== null) {
    const candidate = match[1].replace(/_/g, '-');
    // Only add if it looks like a plausible app name (not too generic)
    if (candidate.length > 3 && !['the', 'and', 'for', 'use', 'you'].includes(candidate)) {
      apps.add(candidate);
    }
  }

  return [...apps];
}
