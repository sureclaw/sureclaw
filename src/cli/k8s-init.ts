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

// ─── Types ──────────────────────────────────────────────────────

export interface InitOptions {
  preset?: string;
  registryUrl?: string;
  registryUser?: string;
  registryPassword?: string;
  model?: string;
  apiKey?: string;
  embeddingsModel?: string;
  embeddingsApiKey?: string;
  database?: string;
  databaseUrl?: string;
  namespace?: string;
  output?: string;
}

const VALID_PRESETS = ['small', 'large'];

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
      case '--preset': opts.preset = next(); break;
      case '--registry-url': opts.registryUrl = next(); break;
      case '--registry-user': opts.registryUser = next(); break;
      case '--registry-password': opts.registryPassword = next(); break;
      case '--model': opts.model = next(); break;
      case '--api-key': opts.apiKey = next(); break;
      case '--embeddings-model': opts.embeddingsModel = next(); break;
      case '--embeddings-api-key': opts.embeddingsApiKey = next(); break;
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
    console.log(`✓ Created namespace ${ns}`);
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
    console.log(`✓ Created secret ${ns}/${name}`);
  } else {
    console.error(`  Failed to create secret ${name}: ${result.output}`);
  }
}

// ─── Values File Generation ────────────────────────────────────

export function generateValuesYaml(opts: {
  preset: string;
  registryUrl?: string;
  model: string;
  embeddingsModel?: string;
  database: string;
}): string {
  const llmProvider = extractProvider(opts.model);
  const lines: string[] = ['# Generated by: ax k8s init', `preset: ${opts.preset}`];

  // Image registry + pull secrets
  if (opts.registryUrl) {
    lines.push('global:');
    lines.push('  imagePullSecrets:');
    lines.push('    - ax-registry-credentials');
    lines.push('imageDefaults:');
    lines.push(`  registry: ${opts.registryUrl}`);
  }

  // Config — model + optional embeddings
  lines.push('config:');
  lines.push('  models:');
  lines.push(`    default: ["${opts.model}"]`);
  if (opts.embeddingsModel) {
    lines.push('  history:');
    lines.push(`    embedding_model: "${opts.embeddingsModel}"`);
  }

  // API credentials — all keys in one secret via apiCredentials.envVars
  const secretKey = secretKeyForProvider(llmProvider);
  const envVar = envVarForProvider(llmProvider);
  lines.push('apiCredentials:');
  lines.push('  existingSecret: ax-api-credentials');
  lines.push('  envVars:');
  lines.push(`    ${envVar}: "${secretKey}"`);

  // Embeddings credentials — same secret, different key
  if (opts.embeddingsModel) {
    const embProvider = extractProvider(opts.embeddingsModel);
    const embEnvVar = envVarForProvider(embProvider);
    if (embEnvVar !== envVar) {
      const embSecretKey = secretKeyForProvider(embProvider);
      lines.push(`    ${embEnvVar}: "${embSecretKey}"`);
    }
  }

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

  return lines.join('\n') + '\n';
}

// ─── Main ──────────────────────────────────────────────────────

export async function runK8sInit(args: string[]): Promise<void> {
  checkKubectl();

  const opts = parseArgs(args);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n── AX Kubernetes Setup ──────────────────────────');

    // 1. Preset
    const preset = opts.preset ?? await askChoice(rl, 'Cluster size?', [
      { value: 'small', description: 'production, single replica' },
      { value: 'large', description: 'high-scale, autoscaling' },
    ]);
    if (!VALID_PRESETS.includes(preset)) {
      console.error(`Invalid preset: ${preset}. Must be one of: ${VALID_PRESETS.join(', ')}`);
      process.exit(1);
    }

    // 2. Docker registry (optional)
    let registryUrl = opts.registryUrl;
    let registryUser = opts.registryUser;
    let registryPassword = opts.registryPassword;
    if (registryUrl === undefined) {
      registryUrl = await ask(rl, '\nDocker registry URL [ghcr.io/ax] (leave empty to skip): ');
      if (registryUrl === '') registryUrl = undefined;
    }
    if (registryUrl) {
      registryUser = registryUser ?? await ask(rl, 'Registry username: ');
      registryPassword = registryPassword ?? await ask(rl, 'Registry password: ');
    }

    // 3. Model (compound provider/model ID)
    const model = opts.model ?? await ask(rl, '\nModel (provider/model, e.g. anthropic/claude-sonnet-4-20250514): ');
    if (!model || !model.includes('/')) {
      console.error(`Invalid model: "${model}". Must be a compound provider/model ID (e.g. "anthropic/claude-sonnet-4-20250514")`);
      process.exit(1);
    }
    const llmProvider = extractProvider(model);
    const apiKey = opts.apiKey ?? await ask(rl, `${llmProvider} API key: `);

    // 4. Embeddings model (optional, compound provider/model ID)
    let embeddingsModel = opts.embeddingsModel;
    let embeddingsApiKey = opts.embeddingsApiKey;
    if (embeddingsModel === undefined) {
      embeddingsModel = await ask(rl, '\nEmbeddings model (provider/model, leave empty to skip): ');
      if (embeddingsModel === '') embeddingsModel = undefined;
    }
    if (embeddingsModel) {
      if (!embeddingsModel.includes('/')) {
        console.error(`Invalid embeddings model: "${embeddingsModel}". Must be a compound provider/model ID (e.g. "deepinfra/qwen/qwen3-embedding-0.6b")`);
        process.exit(1);
      }
      const embProvider = extractProvider(embeddingsModel);
      if (embProvider !== llmProvider) {
        embeddingsApiKey = embeddingsApiKey ?? await ask(rl, `${embProvider} API key: `);
      }
    }

    // 5. Database
    const database = opts.database ?? await askChoice(rl, 'Database?', [
      { value: 'internal', description: 'chart provisions PostgreSQL for you' },
      { value: 'external', description: 'connect to existing PostgreSQL' },
    ]);
    let databaseUrl = opts.databaseUrl;
    if (database === 'external') {
      databaseUrl = databaseUrl ?? await ask(rl, 'PostgreSQL connection URL: ');
    }

    // 6. Namespace + output
    const namespace = opts.namespace ?? 'ax';
    const outputFile = opts.output ?? 'ax-values.yaml';

    // ── Create resources ──────────────────────────────────────
    console.log('\n── Results ──────────────────────────────────────\n');

    createNamespace(namespace);

    // Registry secret
    if (registryUrl && registryUser && registryPassword) {
      await createOrSkipSecret(rl, namespace, 'ax-registry-credentials', [
        'docker-registry', 'ax-registry-credentials',
        `--docker-server=${registryUrl}`,
        `--docker-username=${registryUser}`,
        `--docker-password=${registryPassword}`,
      ]);
    }

    // API credentials secret (LLM + embeddings in one secret)
    const llmSecretKey = secretKeyForProvider(llmProvider);
    const secretLiterals = [`--from-literal=${llmSecretKey}=${apiKey}`];
    if (embeddingsModel && embeddingsApiKey) {
      const embProvider = extractProvider(embeddingsModel);
      const embSecretKey = secretKeyForProvider(embProvider);
      if (embSecretKey !== llmSecretKey) {
        secretLiterals.push(`--from-literal=${embSecretKey}=${embeddingsApiKey}`);
      }
    }
    await createOrSkipSecret(rl, namespace, 'ax-api-credentials', [
      'generic', 'ax-api-credentials',
      ...secretLiterals,
    ]);

    // Database credentials secret
    if (database === 'external' && databaseUrl) {
      await createOrSkipSecret(rl, namespace, 'ax-db-credentials', [
        'generic', 'ax-db-credentials',
        `--from-literal=url=${databaseUrl}`,
      ]);
    }

    // Generate values file
    const valuesYaml = generateValuesYaml({
      preset,
      registryUrl,
      model,
      embeddingsModel,
      database,
    });
    writeFileSync(outputFile, valuesYaml, 'utf-8');
    console.log(`✓ Generated ${outputFile}`);

    console.log(`\nDeploy with:`);
    console.log(`  helm install ax charts/ax -f ${outputFile} -n ${namespace}`);
  } finally {
    rl.close();
  }
}
