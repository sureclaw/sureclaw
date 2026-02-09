import { readFileSync, readdirSync } from 'node:fs';
import { safePath } from '../../utils/safe-path.js';
import type { SkillStoreProvider, SkillMeta, SkillProposal, ProposalResult, SkillLogEntry, LogOptions, Config } from '../types.js';

const DEFAULT_SKILLS_DIR = 'skills';

export async function create(_config: Config): Promise<SkillStoreProvider> {
  const skillsDir = DEFAULT_SKILLS_DIR;

  return {
    async list(): Promise<SkillMeta[]> {
      let files: string[];
      try {
        files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
      } catch {
        return [];
      }

      return files.map(f => ({
        name: f.replace(/\.md$/, ''),
        path: safePath(skillsDir, f),
      }));
    },

    async read(name: string): Promise<string> {
      const filePath = safePath(skillsDir, `${name}.md`);
      return readFileSync(filePath, 'utf-8');
    },

    async propose(_proposal: SkillProposal): Promise<ProposalResult> {
      throw new Error('Skills are read-only in this provider. Use the git provider for modifications.');
    },

    async approve(_proposalId: string): Promise<void> {
      throw new Error('Skills are read-only in this provider.');
    },

    async reject(_proposalId: string): Promise<void> {
      throw new Error('Skills are read-only in this provider.');
    },

    async revert(_commitId: string): Promise<void> {
      throw new Error('Skills are read-only in this provider.');
    },

    async log(_opts?: LogOptions): Promise<SkillLogEntry[]> {
      return [];
    },
  };
}
