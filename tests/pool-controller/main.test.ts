import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We'll test the loadTierConfigs function once exported
import { loadTierConfigs } from '../../src/pool-controller/main.js';

describe('loadTierConfigs', () => {
  let tempDir: string;
  const originalEnv = process.env.SANDBOX_TEMPLATE_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ax-pool-test-'));
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SANDBOX_TEMPLATE_DIR = originalEnv;
    } else {
      delete process.env.SANDBOX_TEMPLATE_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads tier configs from JSON files when SANDBOX_TEMPLATE_DIR is set', () => {
    const lightConfig = {
      tier: 'light',
      minReady: 3,
      maxReady: 15,
      template: {
        image: 'ax/agent:v2',
        command: ['node', '/opt/ax/dist/agent/runner.js'],
        cpu: '2',
        memory: '4Gi',
        tier: 'light',
        natsUrl: 'nats://custom:4222',
        workspaceRoot: '/workspace',
      },
    };
    const heavyConfig = {
      tier: 'heavy',
      minReady: 1,
      maxReady: 5,
      template: {
        image: 'ax/agent:v2',
        command: ['node', '/opt/ax/dist/agent/runner.js'],
        cpu: '8',
        memory: '32Gi',
        tier: 'heavy',
        natsUrl: 'nats://custom:4222',
        workspaceRoot: '/workspace',
      },
    };

    writeFileSync(join(tempDir, 'light.json'), JSON.stringify(lightConfig));
    writeFileSync(join(tempDir, 'heavy.json'), JSON.stringify(heavyConfig));

    process.env.SANDBOX_TEMPLATE_DIR = tempDir;
    const result = loadTierConfigs();

    expect(result).toHaveLength(2);
    expect(result[0]?.tier).toBe('light');
    expect(result[0]?.minReady).toBe(3);
    expect(result[0]?.template.cpu).toBe('2');
    expect(result[1]?.tier).toBe('heavy');
    expect(result[1]?.minReady).toBe(1);
  });

  test('falls back to defaults when SANDBOX_TEMPLATE_DIR is not set', () => {
    delete process.env.SANDBOX_TEMPLATE_DIR;
    const result = loadTierConfigs();

    expect(result).toHaveLength(2);
    expect(result[0]?.tier).toBe('light');
    expect(result[0]?.minReady).toBe(2); // default
    expect(result[1]?.tier).toBe('heavy');
    expect(result[1]?.minReady).toBe(0); // default
  });

  test('default templates use standby command (sleep), not agent runner', () => {
    delete process.env.SANDBOX_TEMPLATE_DIR;
    const result = loadTierConfigs();

    for (const tier of result) {
      expect(tier.template.command).toEqual(['sleep', '86400']);
    }
  });
});
