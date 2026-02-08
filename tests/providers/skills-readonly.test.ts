import { describe, test, expect, beforeEach } from 'vitest';
import { create } from '../../src/providers/skills-readonly.js';
import type { SkillStoreProvider, Config } from '../../src/providers/types.js';

const config = {} as Config;

describe('skills-readonly', () => {
  let skills: SkillStoreProvider;

  beforeEach(async () => {
    skills = await create(config);
  });

  test('lists skills from skills/ directory', async () => {
    const list = await skills.list();
    expect(Array.isArray(list)).toBe(true);
    // We have skills/default.md from Task 0.1
    expect(list.some(s => s.name === 'default')).toBe(true);
  });

  test('reads a skill file', async () => {
    const content = await skills.read('default');
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
  });

  test('throws on path traversal in skill name', async () => {
    // safePath sanitizes this, so it won't find the file
    await expect(skills.read('../../etc/passwd')).rejects.toThrow();
  });

  test('propose throws (read-only)', async () => {
    await expect(
      skills.propose({ skill: 'test', content: 'test' })
    ).rejects.toThrow('read-only');
  });

  test('approve throws (read-only)', async () => {
    await expect(skills.approve('id')).rejects.toThrow('read-only');
  });

  test('reject throws (read-only)', async () => {
    await expect(skills.reject('id')).rejects.toThrow('read-only');
  });

  test('log returns empty array', async () => {
    const log = await skills.log();
    expect(log).toEqual([]);
  });
});
