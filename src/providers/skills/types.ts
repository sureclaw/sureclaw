// src/providers/skills/types.ts — Parsed skill format types (no store provider)

// Re-export screener types from their new home for backward compatibility
export type {
  ScreeningVerdict,
  ScreeningSeverity,
  ScreeningVerdictKind,
  ScreeningReason,
  ExtendedScreeningVerdict,
  SkillScreenerProvider,
} from '../screener/types.js';

/**
 * New install step format: raw `run` commands instead of structured kind/package taxonomy.
 * Each step is a shell command to execute on the host, with optional declarative metadata.
 */
export interface SkillInstallStep {
  run: string;
  label?: string;
  bin?: string;
  os?: string[];
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
  install: SkillInstallStep[];
  os?: string[];
  permissions: string[];
  triggers?: string[];
  tags?: string[];
  body: string;
  codeBlocks: string[];
}

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
      run: string;
      label?: string;
      bin?: string;
      os?: string[];
      approval: 'required';
    }>;
  };
  executables: Array<{
    path: string;
    sha256?: string;
  }>;
}
