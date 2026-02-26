// src/providers/skills/types.ts — Skills provider types

export interface SkillMeta {
  name: string;
  description?: string;
  path: string;
}

export interface SkillProposal {
  skill: string;
  content: string;
  reason?: string;
}

export interface ProposalResult {
  id: string;
  verdict: 'AUTO_APPROVE' | 'NEEDS_REVIEW' | 'REJECT';
  reason: string;
}

export interface LogOptions {
  limit?: number;
  since?: Date;
}

export interface SkillLogEntry {
  id: string;
  skill: string;
  action: 'propose' | 'approve' | 'reject' | 'revert';
  timestamp: Date;
  reason?: string;
}

export interface SkillStoreProvider {
  list(): Promise<SkillMeta[]>;
  read(name: string): Promise<string>;
  propose(proposal: SkillProposal): Promise<ProposalResult>;
  approve(proposalId: string): Promise<void>;
  reject(proposalId: string): Promise<void>;
  revert(commitId: string): Promise<void>;
  log(opts?: LogOptions): Promise<SkillLogEntry[]>;
}

export interface ScreeningVerdict {
  allowed: boolean;
  reasons: string[];
}

// ═══════════════════════════════════════════════════════
// Extended screening types (Phase 3 — static screener)
// ═══════════════════════════════════════════════════════

export type ScreeningSeverity = 'INFO' | 'FLAG' | 'BLOCK';
export type ScreeningVerdictKind = 'APPROVE' | 'REVIEW' | 'REJECT';

export interface ScreeningReason {
  category: string;
  severity: ScreeningSeverity;
  detail: string;
  line?: number;
}

export interface ExtendedScreeningVerdict {
  verdict: ScreeningVerdictKind;
  score: number;
  reasons: ScreeningReason[];
  permissions: string[];
  excessPermissions: string[];
}

// ═══════════════════════════════════════════════════════
// Parsed AgentSkills format (SKILL.md)
// ═══════════════════════════════════════════════════════

export interface AgentSkillInstaller {
  kind: string;
  package: string;
  bins?: string[];
  os?: string[];
  label?: string;
}

export interface ParsedAgentSkill {
  name: string;
  description?: string;
  version?: string;
  license?: string;
  homepage?: string;
  requires: {
    bins: string[];
    env: string[];
    anyBins?: string[][];
    config?: Record<string, string>;
  };
  install: AgentSkillInstaller[];
  os?: string[];
  permissions: string[];
  triggers?: string[];
  tags?: string[];
  body: string;
  codeBlocks: string[];
}

// ═══════════════════════════════════════════════════════
// Generated manifest
// ═══════════════════════════════════════════════════════

export interface GeneratedManifest {
  name: string;
  description?: string;
  version?: string;
  requires: {
    bins: string[];
    env: string[];
    os?: string[];
  };
  capabilities: {
    tools: string[];
    host_commands: string[];
    domains: string[];
  };
  install: {
    steps: Array<{
      kind: string;
      package: string;
      bins?: string[];
      approval: 'required';
    }>;
  };
  executables: Array<{
    path: string;
    sha256?: string;
  }>;
}

export interface SkillScreenerProvider {
  screen(content: string, declaredPermissions?: string[]): Promise<ScreeningVerdict>;
  screenExtended?(content: string, declaredPermissions?: string[]): Promise<ExtendedScreeningVerdict>;
  screenBatch?(items: Array<{ content: string; declaredPermissions?: string[] }>): Promise<ExtendedScreeningVerdict[]>;
}
