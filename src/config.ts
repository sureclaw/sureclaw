import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Config } from './types.js';
import { configPath as defaultConfigPath } from './paths.js';
import { PROFILE_NAMES } from './onboarding/prompts.js';

const AGENT_TYPES = ['pi-agent-core', 'pi-coding-agent', 'claude-code'] as const;

const ChannelAccessConfigSchema = z.object({
  dm_policy: z.enum(['open', 'allowlist', 'disabled']).optional(),
  dmPolicy: z.enum(['open', 'allowlist', 'disabled']).optional(),
  allowed_users: z.array(z.string()).optional(),
  allowedUsers: z.array(z.string()).optional(),
  require_mention: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  mention_patterns: z.array(z.string()).optional(),
  mentionPatterns: z.array(z.string()).optional(),
  max_attachment_bytes: z.number().int().positive().optional(),
  maxAttachmentBytes: z.number().int().positive().optional(),
  allowed_mime_types: z.array(z.string()).optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
});

const ConfigSchema = z.strictObject({
  agent: z.enum(AGENT_TYPES).optional().default('pi-agent-core'),
  profile: z.enum(PROFILE_NAMES),
  providers: z.strictObject({
    llm: z.string(),
    memory: z.string(),
    scanner: z.string(),
    channels: z.array(z.string()),
    web: z.string(),
    browser: z.string(),
    credentials: z.string(),
    skills: z.string(),
    audit: z.string(),
    sandbox: z.string(),
    scheduler: z.string(),
    skillScreener: z.string().optional(),
  }),
  channel_config: z.record(z.string(), ChannelAccessConfigSchema).optional(),
  max_tokens: z.number().int().min(256).max(200_000).optional().default(8192),
  sandbox: z.strictObject({
    timeout_sec: z.number().int().min(1).max(3600),
    memory_mb: z.number().int().min(64).max(8192),
  }),
  scheduler: z.strictObject({
    active_hours: z.strictObject({
      start: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
      end: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format'),
      timezone: z.string(),
    }),
    max_token_budget: z.number().int().min(1),
    heartbeat_interval_min: z.number().int().min(1),
    agent_dir: z.string().optional(),
  }),
});

export function loadConfig(path?: string): Config {
  const configPath = resolve(path ?? defaultConfigPath());
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}
