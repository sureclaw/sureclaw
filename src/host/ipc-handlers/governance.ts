/**
 * IPC handlers: enterprise governance operations.
 *
 * identity_propose — queues identity changes for review (vs identity_write which may auto-apply).
 * proposal_list — lists pending proposals.
 * proposal_review — approves/rejects a proposal (admin-only).
 * agent_registry_list — lists registered agents.
 * agent_registry_get — gets a single agent's details.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { proposalsDir } from '../../paths.js';
import { AgentRegistry } from '../agent-registry.js';

export interface GovernanceHandlerOptions {
  agentDir?: string;
  agentName: string;
  profile: string;
  registry: AgentRegistry;
}

export interface Proposal {
  id: string;
  type: 'identity' | 'capability' | 'config';
  file?: string;
  content: string;
  reason: string;
  origin: string;
  status: 'pending' | 'approved' | 'rejected';
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewReason?: string;
}

function loadProposals(): Proposal[] {
  const dir = proposalsDir();
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
    return files.map((f: string) => {
      const raw = readFileSync(join(dir, f), 'utf-8');
      return JSON.parse(raw) as Proposal;
    });
  } catch {
    return [];
  }
}

function saveProposal(proposal: Proposal): void {
  const dir = proposalsDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${proposal.id}.json`);
  writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf-8');
}

export function createGovernanceHandlers(providers: ProviderRegistry, opts: GovernanceHandlerOptions) {
  const { agentDir, agentName, profile, registry } = opts;

  return {
    identity_propose: async (req: any, ctx: IPCContext) => {
      // Scan content
      const scanResult = await providers.scanner.scanInput({
        content: req.content,
        source: 'identity_proposal',
        sessionId: ctx.sessionId,
      });
      if (scanResult.verdict === 'BLOCK') {
        return { ok: false, error: `Content blocked by scanner: ${scanResult.reason ?? 'policy violation'}` };
      }

      const proposal: Proposal = {
        id: randomUUID(),
        type: 'identity',
        file: req.file,
        content: req.content,
        reason: req.reason,
        origin: req.origin,
        status: 'pending',
        createdBy: ctx.userId ?? ctx.agentId,
        createdAt: new Date().toISOString(),
      };

      saveProposal(proposal);

      await providers.audit.log({
        action: 'identity_propose',
        sessionId: ctx.sessionId,
        args: { proposalId: proposal.id, file: req.file, reason: req.reason },
      });

      return { proposalId: proposal.id, status: 'pending' };
    },

    proposal_list: async (req: any) => {
      const proposals = loadProposals();
      if (req.status) {
        return { proposals: proposals.filter(p => p.status === req.status) };
      }
      return { proposals };
    },

    proposal_review: async (req: any, ctx: IPCContext) => {
      const dir = proposalsDir();
      const filePath = join(dir, `${req.proposalId}.json`);
      if (!existsSync(filePath)) {
        return { ok: false, error: `Proposal ${req.proposalId} not found` };
      }

      const proposal: Proposal = JSON.parse(readFileSync(filePath, 'utf-8'));

      if (proposal.status !== 'pending') {
        return { ok: false, error: `Proposal already ${proposal.status}` };
      }

      proposal.status = req.decision;
      proposal.reviewedBy = ctx.userId ?? ctx.agentId;
      proposal.reviewedAt = new Date().toISOString();
      proposal.reviewReason = req.reason;

      saveProposal(proposal);

      // If approved and it's an identity proposal, apply it
      if (req.decision === 'approved' && proposal.type === 'identity' && proposal.file && agentDir) {
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(agentDir, proposal.file), proposal.content, 'utf-8');

        // Bootstrap completion
        if (proposal.file === 'SOUL.md') {
          try { unlinkSync(join(agentDir, 'BOOTSTRAP.md')); } catch { /* may not exist */ }
        }
      }

      await providers.audit.log({
        action: 'proposal_review',
        sessionId: ctx.sessionId,
        args: {
          proposalId: req.proposalId,
          decision: req.decision,
          reason: req.reason,
          type: proposal.type,
        },
      });

      return { reviewed: true, proposalId: req.proposalId, decision: req.decision };
    },

    agent_registry_list: async (req: any) => {
      const agents = req.status
        ? registry.list(req.status)
        : registry.list();
      return { agents };
    },

    agent_registry_get: async (req: any) => {
      const agent = registry.get(req.agentId);
      if (!agent) {
        return { ok: false, error: `Agent "${req.agentId}" not found` };
      }
      return { agent };
    },
  };
}
