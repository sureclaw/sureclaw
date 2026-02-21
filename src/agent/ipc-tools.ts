import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { IPCClient } from './ipc-client.js';
import { TOOL_CATALOG } from './tool-catalog.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

export interface IPCToolsOptions {
  /** Current user ID — included in user_write calls for per-user scoping. */
  userId?: string;
}

/** Create tools that route through IPC to the host process. */
export function createIPCTools(client: IPCClient, opts?: IPCToolsOptions): AgentTool[] {
  async function ipcCall(action: string, params: Record<string, unknown> = {}) {
    try {
      const result = await client.call({ action, ...params });
      return text(JSON.stringify(result));
    } catch (err: unknown) {
      return text(`Error: ${(err as Error).message}`);
    }
  }

  return TOOL_CATALOG.map(spec => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_id: string, params: unknown) {
      const p = params as Record<string, unknown>;
      const callParams = spec.injectUserId
        ? { ...p, userId: opts?.userId ?? '' }
        : p;
      return ipcCall(spec.name, callParams);
    },
  }));
}
