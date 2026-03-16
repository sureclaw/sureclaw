// src/providers/sandbox/types.ts — Sandbox provider types

export interface SandboxConfig {
  workspace: string;
  ipcSocket: string;
  timeoutSec?: number;
  memoryMB?: number;
  cpus?: number;
  command: string[];

  // ── Three-phase orchestration ──
  /** When true, container has network access (provision/cleanup phases). Default: false. */
  network?: boolean;

  // ── Enterprise mounts (optional) ──
  /** Agent's shared workspace: ~/.ax/agents/<id>/agent/workspace/ */
  agentWorkspace?: string;
  /** Per-user workspace: ~/.ax/agents/<id>/users/<userId>/workspace/ */
  userWorkspace?: string;
  /** When true, /workspace/agent mount is read-write (admin users + workspace provider active). */
  agentWorkspaceWritable?: boolean;
  /** When true, /workspace/user mount is read-write (workspace provider active). */
  userWorkspaceWritable?: boolean;

  // ── Extra environment variables (per-turn, set by host) ──
  /** Additional env vars to inject into the sandbox pod (e.g. IPC tokens). */
  extraEnv?: Record<string, string>;
}

export interface SandboxProcess {
  pid: number;
  exitCode: Promise<number>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  kill(): void;
  /** Host-side socket path for reverse IPC bridge (Apple containers).
   *  When set, the host connects to this socket instead of the agent connecting to the IPC server. */
  bridgeSocketPath?: string;
}

export interface SandboxProvider {
  spawn(config: SandboxConfig): Promise<SandboxProcess>;
  kill(pid: number): Promise<void>;
  isAvailable(): Promise<boolean>;
}
