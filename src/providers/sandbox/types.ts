// src/providers/sandbox/types.ts — Sandbox provider types

export interface SandboxConfig {
  workspace: string;
  ipcSocket: string;
  timeoutSec?: number;
  memoryMB?: number;
  cpus?: number;
  command: string[];

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
  /** Pod name for HTTP work delivery (k8s mode only). */
  podName?: string;
}

export interface SandboxProvider {
  spawn(config: SandboxConfig): Promise<SandboxProcess>;
  kill(pid: number): Promise<void>;
  isAvailable(): Promise<boolean>;
}
