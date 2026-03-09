// tests/cli/k8s-init.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeCommand } from '../../src/cli/index.js';
import { parseArgs, generateValuesYaml, defaultWasmMode, loadPreviousValues } from '../../src/cli/k8s-init.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI Router — k8s command', () => {
  it('should route k8s command with args', async () => {
    const mockK8s = vi.fn();
    await routeCommand(['k8s', 'init', '--preset', 'small'], { k8s: mockK8s });
    expect(mockK8s).toHaveBeenCalledWith(['init', '--preset', 'small']);
  });

  it('should pass subcommand args to k8s handler', async () => {
    const mockK8s = vi.fn();
    await routeCommand(['k8s', 'init'], { k8s: mockK8s });
    expect(mockK8s).toHaveBeenCalledWith(['init']);
  });
});

describe('k8s init — parseArgs', () => {
  it('parses --model flag as compound provider/model ID', () => {
    const opts = parseArgs(['--model', 'anthropic/claude-sonnet-4-20250514']);
    expect(opts.model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('parses --embeddings-model flag as compound provider/model ID', () => {
    const opts = parseArgs(['--embeddings-model', 'deepinfra/qwen/qwen3-embedding-0.6b']);
    expect(opts.embeddingsModel).toBe('deepinfra/qwen/qwen3-embedding-0.6b');
  });

  it('parses all flags together', () => {
    const opts = parseArgs([
      '--preset', 'medium',
      '--model', 'openai/gpt-4o',
      '--api-key', 'sk-test',
      '--embeddings-model', 'openai/text-embedding-3-small',
      '--embeddings-api-key', 'sk-emb',
      '--database', 'internal',
      '--namespace', 'prod',
      '--output', 'custom.yaml',
    ]);
    expect(opts.preset).toBe('medium');
    expect(opts.model).toBe('openai/gpt-4o');
    expect(opts.apiKey).toBe('sk-test');
    expect(opts.embeddingsModel).toBe('openai/text-embedding-3-small');
    expect(opts.embeddingsApiKey).toBe('sk-emb');
    expect(opts.database).toBe('internal');
    expect(opts.namespace).toBe('prod');
    expect(opts.output).toBe('custom.yaml');
  });

  it('parses --wasm flag', () => {
    const opts = parseArgs(['--wasm', 'shadow']);
    expect(opts.wasm).toBe('shadow');
  });

  it('does not have --llm-provider or --embeddings-provider flags', () => {
    const opts = parseArgs(['--llm-provider', 'anthropic', '--embeddings-provider', 'openai']);
    expect(opts).not.toHaveProperty('llmProvider');
    expect(opts).not.toHaveProperty('embeddingsProvider');
  });
});

describe('k8s init — generateValuesYaml', () => {
  it('includes config.models.default from model ID', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('config:');
    expect(yaml).toContain('models:');
    expect(yaml).toContain('default: ["anthropic/claude-sonnet-4-20250514"]');
  });

  it('includes config.history.embedding_model from embeddings model ID', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      embeddingsModel: 'deepinfra/qwen/qwen3-embedding-0.6b',
      database: 'internal',
    });
    expect(yaml).toContain('history:');
    expect(yaml).toContain('embedding_model: "deepinfra/qwen/qwen3-embedding-0.6b"');
  });

  it('derives provider from model ID for apiCredentials env var', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'openrouter/gpt-4.1',
      database: 'internal',
    });
    expect(yaml).toContain('OPENROUTER_API_KEY');
  });

  it('derives provider from embeddings model ID for apiCredentials env var', () => {
    const yaml = generateValuesYaml({
      preset: 'medium',
      model: 'anthropic/claude-sonnet-4-20250514',
      embeddingsModel: 'deepinfra/qwen/qwen3-embedding-0.6b',
      database: 'internal',
    });
    expect(yaml).toContain('ANTHROPIC_API_KEY');
    expect(yaml).toContain('DEEPINFRA_API_KEY');
  });

  it('omits embeddings config when no embeddings model', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).not.toContain('embedding_model');
    expect(yaml).not.toContain('DEEPINFRA_API_KEY');
  });

  it('does not duplicate env var when LLM and embeddings share a provider', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'openai/gpt-4o',
      embeddingsModel: 'openai/text-embedding-3-small',
      database: 'internal',
    });
    // OPENAI_API_KEY should appear exactly once in envVars
    const matches = yaml.match(/OPENAI_API_KEY/g);
    expect(matches).toHaveLength(1);
  });

  it('generates secret key name from provider', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('anthropic-api-key');
  });

  it('still generates postgresql and nats config', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'external',
    });
    expect(yaml).toContain('postgresql:');
    expect(yaml).toContain('nats:');
  });
});

describe('k8s init — defaultWasmMode', () => {
  it('returns enabled for small preset', () => {
    expect(defaultWasmMode('small')).toBe('enabled');
  });

  it('returns shadow for medium preset', () => {
    expect(defaultWasmMode('medium')).toBe('shadow');
  });

  it('returns enabled for large preset', () => {
    expect(defaultWasmMode('large')).toBe('enabled');
  });

  it('returns disabled for unknown preset', () => {
    expect(defaultWasmMode('')).toBe('disabled');
    expect(defaultWasmMode('custom')).toBe('disabled');
  });
});

describe('k8s init — WASM values generation', () => {
  it('includes wasm config when mode is enabled', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
      wasm: 'enabled',
    });
    expect(yaml).toContain('wasm:');
    expect(yaml).toContain('enabled: true');
    expect(yaml).toContain('shadow_mode: false');
  });

  it('includes wasm config when mode is shadow', () => {
    const yaml = generateValuesYaml({
      preset: 'medium',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
      wasm: 'shadow',
    });
    expect(yaml).toContain('wasm:');
    expect(yaml).toContain('enabled: false');
    expect(yaml).toContain('shadow_mode: true');
  });

  it('omits wasm config when mode is disabled', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
      wasm: 'disabled',
    });
    expect(yaml).not.toContain('wasm:');
    expect(yaml).not.toContain('shadow_mode');
  });

  it('uses preset default when wasm is not specified', () => {
    const yaml = generateValuesYaml({
      preset: 'medium',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    // medium preset defaults to shadow mode
    expect(yaml).toContain('wasm:');
    expect(yaml).toContain('enabled: false');
    expect(yaml).toContain('shadow_mode: true');
  });

  it('wasm config is inside the config block (indented)', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
      wasm: 'enabled',
    });
    // wasm should appear between config: block and apiCredentials:
    const configIdx = yaml.indexOf('config:');
    const wasmIdx = yaml.indexOf('  wasm:');
    const apiCredIdx = yaml.indexOf('apiCredentials:');
    expect(wasmIdx).toBeGreaterThan(configIdx);
    expect(wasmIdx).toBeLessThan(apiCredIdx);
  });
});

describe('k8s init — loadPreviousValues', () => {
  const testDir = join(tmpdir(), `ax-k8s-init-test-${process.pid}`);
  const testFile = join(testDir, 'test-values.yaml');

  beforeAll(() => mkdirSync(testDir, { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it('returns empty object for nonexistent file', () => {
    expect(loadPreviousValues('/no/such/file.yaml')).toEqual({});
  });

  it('returns empty object for invalid YAML', () => {
    writeFileSync(testFile, ':: not valid yaml :::', 'utf-8');
    expect(loadPreviousValues(testFile)).toEqual({});
  });

  it('extracts all values from a full generated values file', () => {
    const yaml = generateValuesYaml({
      preset: 'medium',
      registryUrl: 'registry.example.com',
      model: 'anthropic/claude-sonnet-4-20250514',
      embeddingsModel: 'deepinfra/qwen/qwen3-embedding-0.6b',
      database: 'external',
      wasm: 'shadow',
    });
    writeFileSync(testFile, yaml, 'utf-8');
    const prev = loadPreviousValues(testFile);
    expect(prev.preset).toBe('medium');
    expect(prev.registryUrl).toBe('registry.example.com');
    expect(prev.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(prev.embeddingsModel).toBe('deepinfra/qwen/qwen3-embedding-0.6b');
    expect(prev.database).toBe('external');
    expect(prev.wasm).toBe('shadow');
  });

  it('extracts values from a minimal generated values file', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'openai/gpt-4o',
      database: 'internal',
      wasm: 'enabled',
    });
    writeFileSync(testFile, yaml, 'utf-8');
    const prev = loadPreviousValues(testFile);
    expect(prev.preset).toBe('small');
    expect(prev.registryUrl).toBeUndefined();
    expect(prev.model).toBe('openai/gpt-4o');
    expect(prev.embeddingsModel).toBeUndefined();
    expect(prev.database).toBe('internal');
    expect(prev.wasm).toBe('enabled');
  });

  it('returns wasm undefined when wasm section is absent (disabled mode)', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      model: 'openai/gpt-4o',
      database: 'internal',
      wasm: 'disabled',
    });
    writeFileSync(testFile, yaml, 'utf-8');
    const prev = loadPreviousValues(testFile);
    expect(prev.wasm).toBeUndefined();
  });
});

describe('k8s init — security', () => {
  it('uses execFileSync not execSync', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../src/cli/k8s-init.ts', import.meta.url),
      'utf-8',
    );
    expect(source).toContain("import { execFileSync } from 'node:child_process'");
    expect(source).not.toContain("import { execSync }");
    expect(source).not.toMatch(/[^e]execSync\s*\(/);
  });
});
