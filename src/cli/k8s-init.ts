/**
 * `ax k8s init` — Interactive wizard that generates a Helm values file
 * and creates Kubernetes secrets for deploying AX.
 *
 * Uses Node's built-in readline (no new dependencies).
 * Uses execFileSync (not execSync) to avoid shell injection.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { PROFILE_NAMES, PROFILE_DISPLAY_NAMES, PROFILE_DESCRIPTIONS } from '../onboarding/prompts.js';
import type { ProfileName } from '../onboarding/prompts.js';

// ─── Types ──────────────────────────────────────────────────────

export interface InitOptions {
  profile?: string;
  model?: string;
  apiKey?: string;
  database?: string;
  databaseUrl?: string;
  namespace?: string;
  output?: string;
}

/** Extract provider name from a compound `provider/model` ID (split on first `/`). */
function extractProvider(compoundId: string): string {
  const slashIdx = compoundId.indexOf('/');
  if (slashIdx < 0) return compoundId;
  return compoundId.slice(0, slashIdx);
}

/** Derive the Kubernetes secret key name from a provider (e.g. `anthropic` → `anthropic-api-key`). */
function secretKeyForProvider(provider: string): string {
  return `${provider}-api-key`;
}

/** Derive the environment variable name from a provider (e.g. `anthropic` → `ANTHROPIC_API_KEY`). */
function envVarForProvider(provider: string): string {
  return `${provider.toUpperCase()}_API_KEY`;
}

// ─── CLI Argument Parsing ───────────────────────────────────────

export function parseArgs(args: string[]): InitOptions {
  const opts: InitOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    switch (arg) {
      case '--profile': opts.profile = next(); break;
      case '--model': opts.model = next(); break;
      case '--api-key': opts.apiKey = next(); break;
      case '--database': opts.database = next(); break;
      case '--database-url': opts.databaseUrl = next(); break;
      case '--namespace': opts.namespace = next(); break;
      case '--output': opts.output = next(); break;
    }
  }
  return opts;
}

// ─── Readline Helpers ───────────────────────────────────────────

function ask(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function askChoice(
  rl: ReadlineInterface,
  label: string,
  choices: { value: string; description: string }[],
): Promise<string> {
  console.log(`\n${label}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}. ${choices[i].value.padEnd(12)} — ${choices[i].description}`);
  }
  while (true) {
    const answer = await ask(rl, '> ');
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx].value;
    console.log(`  Please enter a number between 1 and ${choices.length}.`);
  }
}

// ─── kubectl Helpers ────────────────────────────────────────────

function kubectlRun(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync('kubectl', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? String(err);
    return { ok: false, output: msg.trim() };
  }
}

function checkKubectl(): void {
  const { ok } = kubectlRun(['version', '--client']);
  if (!ok) {
    console.error('Error: kubectl is not installed or not in PATH.');
    console.error('Install it from: https://kubernetes.io/docs/tasks/tools/');
    process.exit(1);
  }
}

function createNamespace(ns: string): void {
  const { ok } = kubectlRun(['get', 'namespace', ns]);
  if (ok) {
    console.log(`  Namespace ${ns} already exists`);
    return;
  }
  const result = kubectlRun(['create', 'namespace', ns]);
  if (result.ok) {
    console.log(`Created namespace ${ns}`);
  } else {
    console.error(`  Failed to create namespace ${ns}: ${result.output}`);
  }
}

function secretExists(ns: string, name: string): boolean {
  return kubectlRun(['get', 'secret', name, '-n', ns]).ok;
}

async function createOrSkipSecret(
  rl: ReadlineInterface,
  ns: string,
  name: string,
  secretArgs: string[],
): Promise<void> {
  if (secretExists(ns, name)) {
    const answer = await ask(rl, `  Secret ${name} already exists. Overwrite? (y/N) `);
    if (answer.toLowerCase() !== 'y') {
      console.log(`  Skipped ${name}`);
      return;
    }
    kubectlRun(['delete', 'secret', name, '-n', ns]);
  }
  const result = kubectlRun(['create', 'secret', ...secretArgs, '-n', ns]);
  if (result.ok) {
    console.log(`Created secret ${ns}/${name}`);
  } else {
    console.error(`  Failed to create secret ${name}: ${result.output}`);
  }
}

// ─── Values File Generation ────────────────────────────────────

export function generateValuesYaml(opts: {
  profile: string;
  model: string;
  database: string;
}): string {
  const llmProvider = extractProvider(opts.model);
  const lines: string[] = ['# Generated by: ax k8s init'];

  // Config — profile, model, K8s-mode providers
  lines.push('config:');
  lines.push(`  profile: ${opts.profile}`);
  lines.push('  models:');
  lines.push(`    default: ["${opts.model}"]`);
  lines.push('  providers:');
  lines.push('    database: postgresql');
  lines.push('    eventbus: postgres');
  lines.push('    sandbox: k8s');
  lines.push('    workspace: git-http');
  lines.push('    credentials: database');

  // API credentials
  const secretKey = secretKeyForProvider(llmProvider);
  const envVar = envVarForProvider(llmProvider);
  lines.push('apiCredentials:');
  lines.push('  existingSecret: ax-api-credentials');
  lines.push('  envVars:');
  lines.push(`    ${envVar}: "${secretKey}"`);

  // PostgreSQL
  if (opts.database === 'external') {
    lines.push('postgresql:');
    lines.push('  external:');
    lines.push('    enabled: true');
    lines.push('    existingSecret: ax-db-credentials');
    lines.push('    secretKey: url');
    lines.push('  internal:');
    lines.push('    enabled: false');
  } else {
    lines.push('postgresql:');
    lines.push('  external:');
    lines.push('    enabled: false');
    lines.push('  internal:');
    lines.push('    enabled: true');
  }

  // Git server enabled for workspace persistence
  lines.push('gitServer:');
  lines.push('  enabled: true');

  return lines.join('\n') + '\n';
}

// ─── Main ──────────────────────────────────────────────────────

export async function runK8sInit(args: string[]): Promise<void> {
  checkKubectl();

  const opts = parseArgs(args);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n── AX Kubernetes Setup ──────────────────────────');

    // 1. Profile
    const profile = opts.profile ?? await askChoice(rl, 'Security profile?',
      PROFILE_NAMES.map(name => ({
        value: name,
        description: `${PROFILE_DISPLAY_NAMES[name]} — ${PROFILE_DESCRIPTIONS[name]}`,
      })),
    );
    if (!PROFILE_NAMES.includes(profile as ProfileName)) {
      console.error(`Invalid profile: ${profile}. Must be one of: ${PROFILE_NAMES.join(', ')}`);
      process.exit(1);
    }

    // 2. Model (compound provider/model ID)
    const defaultModel = 'anthropic/claude-sonnet-4-20250514';
    const model = opts.model ?? (await ask(rl, `\nModel (provider/model) [${defaultModel}]: `) || defaultModel);
    if (!model || !model.includes('/')) {
      console.error(`Invalid model: "${model}". Must be a compound provider/model ID (e.g. "anthropic/claude-sonnet-4-20250514")`);
      process.exit(1);
    }
    const llmProvider = extractProvider(model);
    const apiKey = opts.apiKey ?? await ask(rl, `${llmProvider} API key: `);

    // 3. Database
    const database = opts.database ?? await askChoice(rl, 'Database?', [
      { value: 'internal', description: 'chart provisions PostgreSQL for you' },
      { value: 'external', description: 'connect to existing PostgreSQL' },
    ]);
    let databaseUrl = opts.databaseUrl;
    if (database === 'external') {
      databaseUrl = databaseUrl ?? await ask(rl, 'PostgreSQL connection URL: ');
    }

    // 4. Namespace + output
    const namespace = opts.namespace ?? 'ax';
    const outputFile = opts.output ?? 'ax-values.yaml';

    // ── Create resources ──────────────────────────────────────
    console.log('\n── Results ──────────────────────────────────────\n');

    createNamespace(namespace);

    // API credentials secret
    const llmSecretKey = secretKeyForProvider(llmProvider);
    await createOrSkipSecret(rl, namespace, 'ax-api-credentials', [
      'generic', 'ax-api-credentials',
      `--from-literal=${llmSecretKey}=${apiKey}`,
    ]);

    // Database credentials secret
    if (database === 'external' && databaseUrl) {
      await createOrSkipSecret(rl, namespace, 'ax-db-credentials', [
        'generic', 'ax-db-credentials',
        `--from-literal=url=${databaseUrl}`,
      ]);
    }

    // Generate values file
    const valuesYaml = generateValuesYaml({ profile, model, database });
    writeFileSync(outputFile, valuesYaml, 'utf-8');
    console.log(`Generated ${outputFile}`);

    console.log(`\nDeploy with:`);
    console.log(`  helm install ax charts/ax -f ${outputFile} -n ${namespace}`);
  } finally {
    rl.close();
  }
}
