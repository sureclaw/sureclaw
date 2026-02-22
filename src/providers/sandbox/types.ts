// src/providers/sandbox/types.ts — Sandbox provider types

export interface SandboxConfig {
  workspace: string;
  skills: string;
  ipcSocket: string;
  agentDir?: string;
  timeoutSec?: number;
  memoryMB?: number;
  command: string[];

  // ── Enterprise three-tier mounts (optional) ──
  /** Agent's shared workspace (read-only): ~/.ax/agents/<id>/agent/workspace/ */
  agentWorkspace?: string;
  /** Per-user workspace (read-write): ~/.ax/agents/<id>/users/<userId>/workspace/ */
  userWorkspace?: string;
  /** Ephemeral scratch directory (read-write): ~/.ax/scratch/<sessionId>/ */
  scratchDir?: string;
}

export interface SandboxProcess {
  pid: number;
  exitCode: Promise<number>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  kill(): void;
}

export interface SandboxProvider {
  spawn(config: SandboxConfig): Promise<SandboxProcess>;
  kill(pid: number): Promise<void>;
  isAvailable(): Promise<boolean>;
}
