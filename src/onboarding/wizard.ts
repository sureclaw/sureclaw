/**
 * Onboarding wizard — generates ax.yaml from answers.
 *
 * Two modes:
 * - Programmatic: call runOnboarding() with OnboardingOptions (for tests and automation)
 * - Interactive: call runConfigure() for terminal-based setup via @inquirer/prompts
 *
 * Supports reconfiguration: loadExistingConfig() reads the current config
 * so the interactive UI can pre-fill answers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { PROFILE_DEFAULTS } from './prompts.js';
import type { ProfileName } from './prompts.js';

export interface OnboardingAnswers {
  profile: ProfileName;
  llmProvider?: string;
  model?: string;
  apiKey: string;
}

export interface OnboardingOptions {
  outputDir: string;
  answers: OnboardingAnswers;
}

export async function runOnboarding(opts: OnboardingOptions): Promise<void> {
  const { outputDir, answers } = opts;
  const defaults = PROFILE_DEFAULTS[answers.profile];

  if (!defaults) {
    throw new Error(`Unknown profile: "${answers.profile}"`);
  }

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  // Load existing config so non-wizard fields (e.g. agent_name, providers)
  // are preserved across reconfiguration.
  const cfgPath = join(outputDir, 'ax.yaml');
  let existing: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try { existing = parseYaml(readFileSync(cfgPath, 'utf-8')) ?? {}; } catch { /* ignore parse errors */ }
  }

  // Merge wizard answers onto existing config
  const config: Record<string, unknown> = {
    ...existing,
    profile: answers.profile,
    ...(() => {
      const models: Record<string, string[]> = {};
      if (answers.model) models.default = [answers.model];
      return Object.keys(models).length > 0 ? { models } : {};
    })(),
    sandbox: {
      ...(typeof existing.sandbox === 'object' && existing.sandbox ? existing.sandbox : {}),
      timeout_sec: defaults.timeoutSec,
      memory_mb: defaults.memoryMb,
    },
  };

  // Write ax.yaml
  const yamlContent = yamlStringify(config, { indent: 2, lineWidth: 120 });
  writeFileSync(cfgPath, yamlContent, 'utf-8');

  // Store credentials in the database
  if (answers.apiKey.trim()) {
    const apiKeyEnvVar = answers.llmProvider && answers.llmProvider !== 'anthropic'
      ? `${answers.llmProvider.toUpperCase()}_API_KEY`
      : 'ANTHROPIC_API_KEY';

    const credProvider = await openCredentialStore(outputDir);
    try {
      await credProvider.set(apiKeyEnvVar, answers.apiKey.trim());
    } finally {
      await credProvider.close();
    }
  }
}

/**
 * Open a lightweight credential store for the wizard.
 * Creates/opens the SQLite database and runs credential migrations.
 */
async function openCredentialStore(configDir: string) {
  // Determine AX_HOME — if outputDir is the standard axHome(), use it.
  // Otherwise (tests), use a data/ subdirectory under outputDir.
  const { axHome } = await import('../paths.js');
  const { dataFile, dataDir } = configDir === axHome()
    ? await import('../paths.js')
    : {
      dataFile: (...segs: string[]) => join(configDir, 'data', ...segs),
      dataDir: () => join(configDir, 'data'),
    };

  mkdirSync(dataDir(), { recursive: true });
  const dbPath = dataFile('ax.db');

  const { createRequire } = await import('node:module');
  const { Kysely, SqliteDialect } = await import('kysely');
  const req = createRequire(import.meta.url);
  const Database = req('better-sqlite3');
  const sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');

  // Load sqlite-vec if available — the shared ax.db may contain vec0 virtual
  // tables from previous server runs, and SQLite errors on open if the
  // extension isn't loaded.
  try {
    const sqliteVec = req('sqlite-vec');
    sqliteVec.load(sqliteDb);
  } catch {
    // sqlite-vec not available — fine as long as no vec0 tables exist yet
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });

  const { runMigrations } = await import('../utils/migrator.js');
  const { credentialDbMigrations } = await import('../providers/credentials/migrations.js');
  const result = await runMigrations(db, credentialDbMigrations('sqlite'), 'credential_migration');
  if (result.error) throw result.error;

  return {
    async set(service: string, value: string): Promise<void> {
      const now = new Date().toISOString();
      await db.insertInto('credential_store')
        .values({ scope: 'global', env_name: service, value, created_at: now, updated_at: now })
        .onConflict(oc => oc.columns(['scope', 'env_name']).doUpdateSet({ value, updated_at: now }))
        .execute();
    },
    async get(service: string): Promise<string | null> {
      const row = await db.selectFrom('credential_store')
        .select('value')
        .where('scope', '=', 'global')
        .where('env_name', '=', service)
        .executeTakeFirst();
      return row ? (row.value as string) : null;
    },
    async close(): Promise<void> {
      await db.destroy();
    },
  };
}

/**
 * Load existing config from a directory, returning OnboardingAnswers
 * or null if no config exists. Used by the interactive configure UI
 * to pre-fill default selections.
 */
export function loadExistingConfig(dir: string): OnboardingAnswers | null {
  const cfgPath = join(dir, 'ax.yaml');
  if (!existsSync(cfgPath)) return null;

  try {
    const raw = readFileSync(cfgPath, 'utf-8');
    const parsed = parseYaml(raw);

    // Derive LLM provider from compound model ID (e.g. "openrouter/gpt-4.1" → "openrouter")
    const defaultModels: string[] | undefined = parsed.models?.default;
    const model: string | undefined = defaultModels?.[0];
    const llmProvider: string | undefined = model ? model.split('/')[0] : undefined;

    return {
      profile: parsed.profile ?? 'balanced',
      model,
      llmProvider,
      apiKey: '', // API key is in the database, not readable from config
    };
  } catch {
    return null;
  }
}

/**
 * Load existing API key from the credential database for reconfigure flow.
 */
export async function loadExistingApiKey(dir: string, llmProvider?: string): Promise<string> {
  try {
    const store = await openCredentialStore(dir);
    try {
      const envVar = llmProvider && llmProvider !== 'anthropic'
        ? `${llmProvider.toUpperCase()}_API_KEY`
        : 'ANTHROPIC_API_KEY';
      return (await store.get(envVar)) ?? '';
    } finally {
      await store.close();
    }
  } catch {
    return '';
  }
}
