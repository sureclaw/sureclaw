// src/providers/mcp/types.ts — MCP gateway provider types
import type { TaintTag } from '../../types.js';

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP server name that provides this tool (set by discoverAllTools). */
  server?: string;
}

export interface McpToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  agentId: string;
  /** Context only (filtering, attribution) — not for auth. */
  userId: string;
  sessionId: string;
}

export interface McpToolResult {
  content: string | Record<string, unknown>;
  isError?: boolean;
  taint: TaintTag;
}

export interface McpCredentialStatus {
  available: boolean;
  app: string;
  authType: 'oauth' | 'api_key';
}

export interface McpProvider {
  callTool(call: McpToolCall): Promise<McpToolResult>;
  credentialStatus(agentId: string, app: string): Promise<McpCredentialStatus>;
  storeCredential(agentId: string, app: string, value: string): Promise<void>;
  listApps(): Promise<Array<{ name: string; description: string; authType: 'oauth' | 'api_key' }>>;
}

export class McpAuthRequiredError extends Error {
  constructor(public readonly status: McpCredentialStatus) {
    super(`Authentication required for ${status.app}`);
    this.name = 'McpAuthRequiredError';
  }
}
