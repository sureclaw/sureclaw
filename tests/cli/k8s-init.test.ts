// tests/cli/k8s-init.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeCommand } from '../../src/cli/index.js';
import { parseArgs, generateValuesYaml } from '../../src/cli/k8s-init.js';

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

  it('parses --tier flag', () => {
    const opts = parseArgs(['--tier', 'heavy']);
    expect(opts.tier).toBe('heavy');
  });

  it('parses all flags together', () => {
    const opts = parseArgs([
      '--preset', 'large',
      '--tier', 'heavy',
      '--model', 'openai/gpt-4o',
      '--api-key', 'sk-test',
      '--embeddings-model', 'openai/text-embedding-3-small',
      '--embeddings-api-key', 'sk-emb',
      '--database', 'internal',
      '--namespace', 'prod',
      '--output', 'custom.yaml',
    ]);
    expect(opts.preset).toBe('large');
    expect(opts.tier).toBe('heavy');
    expect(opts.model).toBe('openai/gpt-4o');
    expect(opts.apiKey).toBe('sk-test');
    expect(opts.embeddingsModel).toBe('openai/text-embedding-3-small');
    expect(opts.embeddingsApiKey).toBe('sk-emb');
    expect(opts.database).toBe('internal');
    expect(opts.namespace).toBe('prod');
    expect(opts.output).toBe('custom.yaml');
  });

  it('parses --mcp-url flag', () => {
    const opts = parseArgs(['--mcp-url', 'http://activepieces.ax.svc:8080']);
    expect(opts.mcpUrl).toBe('http://activepieces.ax.svc:8080');
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
      tier: 'light',
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
      tier: 'light',
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
      tier: 'light',
      model: 'openrouter/gpt-4.1',
      database: 'internal',
    });
    expect(yaml).toContain('OPENROUTER_API_KEY');
  });

  it('derives provider from embeddings model ID for apiCredentials env var', () => {
    const yaml = generateValuesYaml({
      preset: 'large',
      tier: 'light',
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
      tier: 'light',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).not.toContain('embedding_model');
    expect(yaml).not.toContain('DEEPINFRA_API_KEY');
  });

  it('does not duplicate env var when LLM and embeddings share a provider', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      tier: 'light',
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
      tier: 'light',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('anthropic-api-key');
  });

  it('includes MCP provider config when mcpUrl is set', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      tier: 'light',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
      mcpUrl: 'http://activepieces.ax.svc:8080',
    });
    expect(yaml).toContain('mcp: activepieces');
    expect(yaml).toContain('url: "http://activepieces.ax.svc:8080"');
  });

  it('omits MCP config when mcpUrl is not set', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      tier: 'light',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).not.toContain('mcp:');
    expect(yaml).not.toContain('activepieces');
  });

  it('still generates postgresql and nats config', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      tier: 'light',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'external',
    });
    expect(yaml).toContain('postgresql:');
    expect(yaml).toContain('nats:');
  });

  it('enables only light tier warm pool when tier is light', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      tier: 'light',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('sandbox:');
    expect(yaml).toContain('tiers:');
    expect(yaml).toContain('light:');
    expect(yaml).toContain('heavy:');
    // light tier should have minReady: 2, heavy should have minReady: 0
    const lightSection = yaml.split('light:')[1].split('heavy:')[0];
    expect(lightSection).toContain('minReady: 2');
    const heavySection = yaml.split('heavy:')[1];
    expect(heavySection).toContain('minReady: 0');
    expect(heavySection).toContain('maxReady: 0');
  });

  it('enables only heavy tier warm pool when tier is heavy', () => {
    const yaml = generateValuesYaml({
      preset: 'small',
      tier: 'heavy',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    const lightSection = yaml.split('light:')[1].split('heavy:')[0];
    expect(lightSection).toContain('minReady: 0');
    expect(lightSection).toContain('maxReady: 0');
    const heavySection = yaml.split('heavy:')[1];
    expect(heavySection).toContain('minReady: 2');
    expect(heavySection).toContain('maxReady: 10');
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
