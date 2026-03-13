/**
 * Readonly skill store backed by DocumentStore.
 *
 * Skills are stored as documents in the 'skills' collection with keys
 * like '<agentName>/<skillPath>'. The propose() method writes directly
 * to DocumentStore (auto-approve).
 */
import { randomUUID } from 'node:crypto';
import type { SkillStoreProvider, SkillMeta, SkillProposal, ProposalResult, SkillLogEntry, LogOptions } from './types.js';
import type { Config } from '../../types.js';
import type { StorageProvider } from '../storage/types.js';

export interface CreateOptions {
  screener?: unknown;
  storage?: StorageProvider;
}

export async function create(config: Config, _name?: string, opts?: CreateOptions): Promise<SkillStoreProvider> {
  const agentName = config.agent_name ?? 'main';
  const documents = opts?.storage?.documents;

  if (!documents) {
    throw new Error('readonly skills provider requires storage provider with DocumentStore');
  }

  return {
    async list(): Promise<SkillMeta[]> {
      const allKeys = await documents.list('skills');
      const prefix = `${agentName}/`;
      const agentKeys = allKeys.filter(k => k.startsWith(prefix) && !k.includes('/users/'));
      return agentKeys.map(k => {
        const relPath = k.slice(prefix.length);
        return { name: relPath.replace(/\.md$/, ''), path: relPath };
      });
    },

    async read(name: string): Promise<string> {
      // name could be a flat name ('deploy') or a path ('ops/deploy')
      // Try with .md suffix first, then without
      const keyWithMd = `${agentName}/${name}.md`;
      let content = await documents.get('skills', keyWithMd);
      if (content) return content;

      const key = `${agentName}/${name}`;
      content = await documents.get('skills', key);
      if (content) return content;

      throw new Error(`Skill not found: ${name}`);
    },

    async propose(proposal: SkillProposal): Promise<ProposalResult> {
      const key = `${agentName}/${proposal.skill}.md`;
      await documents.put('skills', key, proposal.content);
      return { id: randomUUID(), verdict: 'AUTO_APPROVE', reason: 'Applied to document store' };
    },

    async approve(_proposalId: string): Promise<void> {
      // No-op: proposals are auto-applied in propose()
    },

    async reject(_proposalId: string): Promise<void> {
      // No-op: proposals are auto-applied in propose()
    },

    async revert(_commitId: string): Promise<void> {
      throw new Error('Revert not supported in readonly provider.');
    },

    async log(_opts?: LogOptions): Promise<SkillLogEntry[]> {
      return [];
    },
  };
}
