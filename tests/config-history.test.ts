import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('history config', () => {
  const tmpDir = join(tmpdir(), 'ax-config-history-test');

  function writeConfig(yaml: string): string {
    mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, 'ax.yaml');
    writeFileSync(p, yaml);
    return p;
  }

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('applies default history settings when history section is omitted', () => {
    const p = writeConfig(`
profile: balanced
providers:
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 256
scheduler:
  active_hours: { start: "00:00", end: "23:59", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    const config = loadConfig(p);
    expect(config.history).toEqual({ max_turns: 50, thread_context_turns: 5, summarize: false, summarize_threshold: 40, summarize_keep_recent: 10, memory_recall: false, memory_recall_limit: 5, memory_recall_scope: '*', embedding_model: 'text-embedding-3-small', embedding_dimensions: 1536 });
  });

  it('accepts explicit history settings', () => {
    const p = writeConfig(`
profile: balanced
providers:
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 256
scheduler:
  active_hours: { start: "00:00", end: "23:59", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
history:
  max_turns: 100
  thread_context_turns: 10
`);
    const config = loadConfig(p);
    expect(config.history.max_turns).toBe(100);
    expect(config.history.thread_context_turns).toBe(10);
  });

  it('rejects max_turns less than 0', () => {
    const p = writeConfig(`
profile: balanced
providers:
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 256
scheduler:
  active_hours: { start: "00:00", end: "23:59", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
history:
  max_turns: -1
  thread_context_turns: 5
`);
    expect(() => loadConfig(p)).toThrow();
  });
});
