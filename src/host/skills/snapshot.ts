import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSkillFile } from '../../skills/parser.js';
import type { SkillSnapshotEntry } from './types.js';

const execFileAsync = promisify(execFile);

const SKILL_PATH_RE = /^\.ax\/skills\/([^/]+)\/SKILL\.md$/;

/**
 * Walks `.ax/skills/<name>/SKILL.md` files in the given ref of a bare repo
 * and returns a parsed SkillSnapshotEntry for each. Results are sorted by
 * skill name ascending for deterministic consumer behavior.
 *
 * Subprocess notes:
 *   - Uses execFile (no shell) with array args to avoid injection.
 *   - If `.ax/skills/` does not exist in the ref, `git ls-tree` succeeds with
 *     empty stdout; no try/catch swallows real failures.
 */
export async function buildSnapshotFromBareRepo(
  bareRepoPath: string,
  ref: string,
): Promise<SkillSnapshotEntry[]> {
  // Fresh bare repos don't have `refs/heads/main` yet — git's `rev-parse
  // --verify` returns non-zero. Treat that as "empty snapshot" rather than
  // an error, so the first turn on a brand-new agent doesn't crash the
  // entire completion path. The caller (loadSnapshot, getAgentSkills,
  // populateCatalogFromSkills) correctly handles an empty array.
  try {
    await execFileAsync(
      'git',
      ['-C', bareRepoPath, 'rev-parse', '--verify', `${ref}^{commit}`],
      { encoding: 'buffer' },
    );
  } catch {
    return [];
  }

  const { stdout: lsOut } = await execFileAsync(
    'git',
    ['-C', bareRepoPath, 'ls-tree', '-r', '--name-only', ref, '--', '.ax/skills/'],
    { encoding: 'buffer' },
  );
  const paths = lsOut
    .toString('utf-8')
    .split('\n')
    .filter((p) => p.length > 0);

  const entries: SkillSnapshotEntry[] = [];
  for (const p of paths) {
    const match = p.match(SKILL_PATH_RE);
    if (!match) continue;
    const name = match[1];
    const { stdout: showOut } = await execFileAsync(
      'git',
      ['-C', bareRepoPath, 'show', `${ref}:${p}`],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    const content = showOut.toString('utf-8');
    const result = parseSkillFile(content);
    if (result.ok) {
      entries.push({
        name,
        ok: true,
        frontmatter: result.frontmatter,
        body: result.body,
      });
    } else {
      entries.push({ name, ok: false, error: result.error });
    }
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}
