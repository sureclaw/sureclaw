/**
 * Git-backed skill store provider.
 *
 * Skills are stored as files in a git repository. Modifications go through a
 * propose → review → approve/reject → commit workflow. Hard-reject patterns
 * (shell, base64, eval) are never overridable.
 *
 * Uses isomorphic-git for git operations (no native git dependency required).
 * All file paths use safePath() (SC-SEC-004).
 */

import * as git from 'isomorphic-git';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import { safePath } from '../../utils/safe-path.js';
import type {
  SkillStoreProvider,
  SkillMeta,
  SkillProposal,
  ProposalResult,
  SkillLogEntry,
  LogOptions,
  Config,
} from '../types.js';

// ═══════════════════════════════════════════════════════
// Hard-reject patterns (never overridable)
// ═══════════════════════════════════════════════════════

const HARD_REJECT_PATTERNS: { regex: RegExp; reason: string }[] = [
  // Shell execution
  { regex: /\bexec\s*\(/i, reason: 'exec() call detected' },
  { regex: /\bchild_process\b/i, reason: 'child_process module reference' },
  { regex: /\bspawn\s*\(/i, reason: 'spawn() call detected' },
  { regex: /\bexecSync\s*\(/i, reason: 'execSync() call detected' },
  { regex: /\$\(\s*(curl|wget|nc|bash|sh)\b/i, reason: 'shell command substitution' },
  { regex: /\|\s*(bash|sh|zsh|cmd|powershell)\b/i, reason: 'pipe to shell' },

  // Code execution
  { regex: /\beval\s*\(/i, reason: 'eval() call detected' },
  { regex: /\bnew\s+Function\s*\(/i, reason: 'Function constructor detected' },

  // Encoding-based evasion
  { regex: /\batob\s*\(/i, reason: 'atob() (base64 decode) detected' },
  { regex: /\bBuffer\.from\s*\([^)]*,\s*['"]base64['"]\s*\)/i, reason: 'base64 Buffer.from detected' },

  // Dangerous imports
  { regex: /\brequire\s*\(\s*['"](?:child_process|net|dgram|cluster|worker_threads)['"]\s*\)/i, reason: 'dangerous module require' },
  { regex: /\bimport\s+.*from\s+['"](?:child_process|net|dgram|cluster|worker_threads)['"]/i, reason: 'dangerous module import' },

  // Network access
  { regex: /\bfetch\s*\(/i, reason: 'fetch() call detected (network access)' },
  { regex: /\bXMLHttpRequest\b/i, reason: 'XMLHttpRequest reference' },
];

// ═══════════════════════════════════════════════════════
// Capability patterns (flag for review)
// ═══════════════════════════════════════════════════════

const CAPABILITY_PATTERNS: { regex: RegExp; capability: string }[] = [
  { regex: /\bfs\b.*\b(write|unlink|rm|mkdir|append)/i, capability: 'filesystem-write' },
  { regex: /\bprocess\.env\b/i, capability: 'env-access' },
  { regex: /\bprocess\.exit\b/i, capability: 'process-exit' },
  { regex: /\bcrypto\b/i, capability: 'crypto-access' },
];

// ═══════════════════════════════════════════════════════
// Proposal state
// ═══════════════════════════════════════════════════════

interface PendingProposal {
  id: string;
  skill: string;
  content: string;
  reason?: string;
  verdict: 'AUTO_APPROVE' | 'NEEDS_REVIEW' | 'REJECT';
  rejectReason?: string;
  capabilities: string[];
  createdAt: Date;
}

// ═══════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════

export async function create(config: Config): Promise<SkillStoreProvider> {
  const skillsDir = 'skills';
  const gitDir = skillsDir;

  // Ensure skills directory exists
  fs.mkdirSync(skillsDir, { recursive: true });

  // Initialize git repo if needed
  try {
    await git.findRoot({ fs, filepath: skillsDir });
  } catch {
    await git.init({ fs, dir: gitDir });
    // Initial commit with any existing files
    const existingFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    for (const file of existingFiles) {
      await git.add({ fs, dir: gitDir, filepath: file });
    }
    if (existingFiles.length > 0) {
      await git.commit({
        fs, dir: gitDir,
        message: 'Initial skills commit',
        author: { name: 'sureclaw', email: 'sureclaw@localhost' },
      });
    }
  }

  // In-memory proposal store
  const proposals = new Map<string, PendingProposal>();

  // In-memory log
  const logEntries: SkillLogEntry[] = [];

  function addLog(skill: string, action: SkillLogEntry['action'], reason?: string): string {
    const id = randomUUID();
    logEntries.push({
      id,
      skill,
      action,
      timestamp: new Date(),
      reason,
    });
    return id;
  }

  function validateContent(content: string): {
    verdict: 'AUTO_APPROVE' | 'NEEDS_REVIEW' | 'REJECT';
    reason?: string;
    capabilities: string[];
  } {
    // Check hard-reject patterns first
    for (const pattern of HARD_REJECT_PATTERNS) {
      if (pattern.regex.test(content)) {
        return {
          verdict: 'REJECT',
          reason: `Hard reject: ${pattern.reason}`,
          capabilities: [],
        };
      }
    }

    // Check capability patterns
    const capabilities: string[] = [];
    for (const pattern of CAPABILITY_PATTERNS) {
      if (pattern.regex.test(content)) {
        capabilities.push(pattern.capability);
      }
    }

    // If capabilities detected, needs review
    if (capabilities.length > 0) {
      return {
        verdict: 'NEEDS_REVIEW',
        reason: `Capabilities detected: ${capabilities.join(', ')}`,
        capabilities,
      };
    }

    // Safe content can be auto-approved
    return { verdict: 'AUTO_APPROVE', capabilities: [] };
  }

  async function getDriftStats(): Promise<{ totalFiles: number; totalChanges: number }> {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    let totalChanges = 0;

    try {
      const log = await git.log({ fs, dir: gitDir, depth: 100 });
      totalChanges = log.length;
    } catch {
      // No commits yet
    }

    return { totalFiles: files.length, totalChanges };
  }

  return {
    async list(): Promise<SkillMeta[]> {
      let files: string[];
      try {
        files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
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
      return fs.readFileSync(filePath, 'utf-8');
    },

    async propose(proposal: SkillProposal): Promise<ProposalResult> {
      const { skill, content, reason } = proposal;

      // Sanitize skill name via safePath (SC-SEC-004) and extract the safe filename
      const safeFilePath = safePath(skillsDir, `${skill}.md`);
      const safeFilename = basename(safeFilePath); // e.g. "my-skill.md"

      // Validate content
      const validation = validateContent(content);

      const id = randomUUID();
      const pending: PendingProposal = {
        id,
        skill: safeFilename.replace(/\.md$/, ''), // store sanitized name
        content,
        reason,
        verdict: validation.verdict,
        rejectReason: validation.reason,
        capabilities: validation.capabilities,
        createdAt: new Date(),
      };

      if (validation.verdict === 'REJECT') {
        addLog(skill, 'reject', validation.reason);
        // Don't store rejected proposals
        return {
          id,
          verdict: 'REJECT',
          reason: validation.reason ?? 'Content rejected by security scan',
        };
      }

      // Store proposal for review/approval
      proposals.set(id, pending);
      addLog(pending.skill, 'propose', validation.reason);

      if (validation.verdict === 'AUTO_APPROVE') {
        // Auto-approve: write file and commit immediately
        fs.writeFileSync(safeFilePath, content, 'utf-8');

        await git.add({ fs, dir: gitDir, filepath: safeFilename });
        await git.commit({
          fs, dir: gitDir,
          message: `skill: auto-approve ${pending.skill}\n\n${reason ?? 'No reason provided'}`,
          author: { name: 'sureclaw', email: 'sureclaw@localhost' },
        });

        addLog(pending.skill, 'approve', 'Auto-approved: no dangerous capabilities detected');
        proposals.delete(id);

        return {
          id,
          verdict: 'AUTO_APPROVE',
          reason: 'Content passes all security checks — auto-approved and committed',
        };
      }

      // NEEDS_REVIEW
      return {
        id,
        verdict: 'NEEDS_REVIEW',
        reason: validation.reason ?? 'Content requires manual review',
      };
    },

    async approve(proposalId: string): Promise<void> {
      const pending = proposals.get(proposalId);
      if (!pending) {
        throw new Error(`Proposal not found: ${proposalId}`);
      }

      if (pending.verdict === 'REJECT') {
        throw new Error(`Cannot approve a rejected proposal: ${pending.rejectReason}`);
      }

      // Write file and commit (pending.skill is already sanitized)
      const safeFilename = `${pending.skill}.md`;
      const filePath = safePath(skillsDir, safeFilename);
      fs.writeFileSync(filePath, pending.content, 'utf-8');

      await git.add({ fs, dir: gitDir, filepath: safeFilename });
      const commitOid = await git.commit({
        fs, dir: gitDir,
        message: `skill: approve ${pending.skill}\n\n${pending.reason ?? 'No reason provided'}\nCapabilities: ${pending.capabilities.join(', ')}`,
        author: { name: 'sureclaw', email: 'sureclaw@localhost' },
      });

      addLog(pending.skill, 'approve', `Manually approved (commit: ${commitOid.slice(0, 7)})`);
      proposals.delete(proposalId);
    },

    async reject(proposalId: string): Promise<void> {
      const pending = proposals.get(proposalId);
      if (!pending) {
        throw new Error(`Proposal not found: ${proposalId}`);
      }

      addLog(pending.skill, 'reject', 'Manually rejected by user');
      proposals.delete(proposalId);
    },

    async revert(commitId: string): Promise<void> {
      // Find the commit to revert
      let commits: Awaited<ReturnType<typeof git.log>>;
      try {
        commits = await git.log({ fs, dir: gitDir, depth: 100 });
      } catch {
        throw new Error(`Commit not found: ${commitId}`);
      }
      const commitToRevert = commits.find(c => c.oid.startsWith(commitId));

      if (!commitToRevert) {
        throw new Error(`Commit not found: ${commitId}`);
      }

      // Get parent commit's tree
      const parentOid = commitToRevert.commit.parent[0];
      if (!parentOid) {
        throw new Error('Cannot revert the initial commit');
      }

      // Read parent tree to restore files
      const parentFiles = await git.listFiles({ fs, dir: gitDir, ref: parentOid });
      const currentFiles = await git.listFiles({ fs, dir: gitDir, ref: commitToRevert.oid });

      // Files added in the commit (remove them)
      const addedFiles = currentFiles.filter(f => !parentFiles.includes(f));
      for (const file of addedFiles) {
        const filePath = safePath(skillsDir, file);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          await git.remove({ fs, dir: gitDir, filepath: file });
        }
      }

      // Files modified or deleted (restore from parent)
      for (const file of parentFiles) {
        const blob = await git.readBlob({ fs, dir: gitDir, oid: parentOid, filepath: file });
        const filePath = safePath(skillsDir, file);
        fs.writeFileSync(filePath, Buffer.from(blob.blob));
        await git.add({ fs, dir: gitDir, filepath: file });
      }

      await git.commit({
        fs, dir: gitDir,
        message: `skill: revert ${commitToRevert.oid.slice(0, 7)}\n\nReverting: ${commitToRevert.commit.message}`,
        author: { name: 'sureclaw', email: 'sureclaw@localhost' },
      });

      // Extract skill name from commit message
      const skillMatch = commitToRevert.commit.message.match(/skill:\s+\w+\s+(\S+)/);
      addLog(skillMatch?.[1] ?? 'unknown', 'revert', `Reverted commit ${commitToRevert.oid.slice(0, 7)}`);
    },

    async log(opts?: LogOptions): Promise<SkillLogEntry[]> {
      let entries = [...logEntries];

      if (opts?.since) {
        entries = entries.filter(e => e.timestamp >= opts.since!);
      }

      // Sort by timestamp descending (newest first)
      entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      if (opts?.limit) {
        entries = entries.slice(0, opts.limit);
      }

      return entries;
    },
  };
}
