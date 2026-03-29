// src/plugins/types.ts — Cowork plugin types

/** Parsed Cowork plugin manifest (.claude-plugin/plugin.json). */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
}

/** A single skill extracted from skills/{name}/SKILL.md. */
export interface PluginSkill {
  /** Directory name (e.g., 'call-prep'). */
  name: string;
  /** Full SKILL.md content. */
  content: string;
}

/** A slash command extracted from commands/*.md. */
export interface PluginCommand {
  /** File stem (e.g., 'forecast' from forecast.md). */
  name: string;
  /** Full command file content. */
  content: string;
}

/** An MCP server extracted from .mcp.json. */
export interface PluginMcpServer {
  /** Logical name (e.g., 'slack', 'hubspot'). */
  name: string;
  /** Server type (always 'http' for now). */
  type: string;
  /** MCP server endpoint URL. */
  url: string;
}

/** A fully parsed Cowork plugin bundle. */
export interface PluginBundle {
  manifest: PluginManifest;
  skills: PluginSkill[];
  commands: PluginCommand[];
  mcpServers: PluginMcpServer[];
}

/** Per-agent installed plugin record (stored in DB). */
export interface InstalledPlugin {
  pluginName: string;
  source: string;
  version: string;
  description: string;
  agentId: string;
  skillCount: number;
  commandCount: number;
  /** Full MCP server configs (persisted for restart recovery). */
  mcpServers: PluginMcpServer[];
  installedAt: string;
}
