import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Config } from './providers/types.js';
import { configPath as defaultConfigPath } from './paths.js';
import { PROFILE_NAMES } from './onboarding/prompts.js';

const ConfigSchema = z.strictObject({
  profile: z.enum(PROFILE_NAMES),
  providers: z.strictObject({
    llm: z.string(),
    memory: z.string(),
    scanner: z.string(),
    channels: z.array(z.string()).min(1),
    web: z.string(),
    browser: z.string(),
    credentials: z.string(),
    skills: z.string(),
    audit: z.string(),
    sandbox: z.string(),
    scheduler: z.string(),
    skillScreener: z.string().optional(),
  }),
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
  }),
});

export function loadConfig(path?: string): Config {
  const configPath = resolve(path ?? defaultConfigPath());
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}
