// tests/cli/k8s-init.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeCommand } from '../../src/cli/index.js';
import { parseArgs, generateValuesYaml } from '../../src/cli/k8s-init.js';

describe('CLI Router — k8s command', () => {
  it('should route k8s command with args', async () => {
    const mockK8s = vi.fn();
    await routeCommand(['k8s', 'init', '--profile', 'balanced'], { k8s: mockK8s });
    expect(mockK8s).toHaveBeenCalledWith(['init', '--profile', 'balanced']);
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

  it('parses --profile flag', () => {
    const opts = parseArgs(['--profile', 'paranoid']);
    expect(opts.profile).toBe('paranoid');
  });

  it('parses all flags together', () => {
    const opts = parseArgs([
      '--profile', 'balanced',
      '--model', 'openai/gpt-4o',
      '--api-key', 'sk-test',
      '--database', 'internal',
      '--namespace', 'prod',
      '--output', 'custom.yaml',
    ]);
    expect(opts.profile).toBe('balanced');
    expect(opts.model).toBe('openai/gpt-4o');
    expect(opts.apiKey).toBe('sk-test');
    expect(opts.database).toBe('internal');
    expect(opts.namespace).toBe('prod');
    expect(opts.output).toBe('custom.yaml');
  });

  it('does not have removed flags', () => {
    const opts = parseArgs(['--preset', 'small', '--registry-url', 'ghcr.io']);
    expect(opts).not.toHaveProperty('preset');
    expect(opts).not.toHaveProperty('registryUrl');
  });
});

describe('k8s init — generateValuesYaml', () => {
  it('includes config.models.default from model ID', () => {
    const yaml = generateValuesYaml({
      profile: 'balanced',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('config:');
    expect(yaml).toContain('models:');
    expect(yaml).toContain('default: ["anthropic/claude-sonnet-4-20250514"]');
  });

  it('includes profile in generated config', () => {
    const yaml = generateValuesYaml({
      profile: 'paranoid',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('profile: paranoid');
  });

  it('includes K8s-mode providers', () => {
    const yaml = generateValuesYaml({
      profile: 'balanced',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('database: postgresql');
    expect(yaml).toContain('eventbus: postgres');
    expect(yaml).toContain('sandbox: k8s');
    expect(yaml).toContain('workspace: git-http');
    expect(yaml).toContain('credentials: database');
  });

  it('derives provider from model ID for apiCredentials env var', () => {
    const yaml = generateValuesYaml({
      profile: 'balanced',
      model: 'openrouter/gpt-4.1',
      database: 'internal',
    });
    expect(yaml).toContain('OPENROUTER_API_KEY');
  });

  it('generates secret key name from provider', () => {
    const yaml = generateValuesYaml({
      profile: 'balanced',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('anthropic-api-key');
  });

  it('generates external postgresql config', () => {
    const yaml = generateValuesYaml({
      profile: 'balanced',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'external',
    });
    expect(yaml).toContain('postgresql:');
    expect(yaml).toContain('existingSecret: ax-db-credentials');
  });

  it('generates internal postgresql config', () => {
    const yaml = generateValuesYaml({
      profile: 'balanced',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('internal:');
    expect(yaml).toContain('enabled: true');
  });

  it('enables git server', () => {
    const yaml = generateValuesYaml({
      profile: 'balanced',
      model: 'anthropic/claude-sonnet-4-20250514',
      database: 'internal',
    });
    expect(yaml).toContain('gitServer:');
    expect(yaml).toContain('enabled: true');
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
