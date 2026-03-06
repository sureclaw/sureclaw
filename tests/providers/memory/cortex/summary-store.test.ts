import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSummaryStore } from '../../../../src/providers/memory/cortex/summary-store.js';

describe('FileSummaryStore', () => {
  let memoryDir: string;
  let store: FileSummaryStore;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'cortex-summary-'));
    store = new FileSummaryStore(memoryDir);
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  it('writes and reads a summary round-trip', async () => {
    await store.write('preferences', '# preferences\n## Editor\n- Uses vim\n');
    const read = await store.read('preferences');
    expect(read).toBe('# preferences\n## Editor\n- Uses vim\n');
  });

  it('returns null for non-existent category', async () => {
    expect(await store.read('nonexistent')).toBeNull();
  });

  it('overwrites existing summary', async () => {
    await store.write('preferences', 'old');
    await store.write('preferences', 'new');
    expect(await store.read('preferences')).toBe('new');
  });

  it('lists category slugs', async () => {
    await store.write('preferences', 'content');
    await store.write('knowledge', 'content');
    const cats = await store.list();
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('initDefaults creates 10 default categories', async () => {
    await store.initDefaults();
    const cats = await store.list();
    expect(cats).toHaveLength(10);
    expect(cats).toContain('preferences');
    const content = await store.read('preferences');
    expect(content).toContain('# preferences');
  });

  it('user-scoped write is isolated from shared', async () => {
    await store.write('preferences', 'alice prefs', 'alice');
    await store.write('preferences', 'shared prefs');
    expect(await store.read('preferences', 'alice')).toBe('alice prefs');
    expect(await store.read('preferences')).toBe('shared prefs');
  });

  it('list with userId returns user categories', async () => {
    await store.write('preferences', 'alice prefs', 'alice');
    await store.write('knowledge', 'alice knowledge', 'alice');
    const cats = await store.list('alice');
    expect(cats.sort()).toEqual(['knowledge', 'preferences']);
  });

  it('sanitizes path traversal attempts', async () => {
    await store.write('../escape', 'safe content');
    const files = await readdir(memoryDir);
    expect(files.some(f => f.endsWith('.md'))).toBe(true);
    expect(files.every(f => !f.includes('..'))).toBe(true);
    const read = await store.read('../escape');
    expect(read).toBe('safe content');
  });

  it('writes atomically (no .tmp files left)', async () => {
    await store.write('preferences', 'content');
    const files = await readdir(memoryDir);
    expect(files.every(f => !f.endsWith('.tmp'))).toBe(true);
  });

  it('readAll returns all summaries', async () => {
    await store.write('preferences', 'prefs content');
    await store.write('knowledge', 'knowledge content');
    const all = await store.readAll();
    expect(all.size).toBe(2);
    expect(all.get('preferences')).toBe('prefs content');
    expect(all.get('knowledge')).toBe('knowledge content');
  });
});
