import { z } from 'zod';
import type { PluginManifest, PluginSkill, PluginCommand, PluginMcpServer, PluginBundle } from './types.js';
import { basename, dirname } from 'node:path';

const ManifestSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  description: z.string().min(1).max(2000),
  author: z.object({ name: z.string() }).optional(),
});

const McpJsonSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({
      type: z.string().default('http'),
      url: z.string().url(),
    }),
  ),
});

export function parsePluginManifest(raw: unknown): PluginManifest {
  const parsed = ManifestSchema.parse(raw);
  return {
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    author: parsed.author?.name,
  };
}

export function parsePluginBundle(files: Map<string, string>): PluginBundle {
  const manifestContent = files.get('.claude-plugin/plugin.json');
  if (!manifestContent) {
    throw new Error('Plugin is missing .claude-plugin/plugin.json');
  }
  const manifest = parsePluginManifest(JSON.parse(manifestContent));

  const skills: PluginSkill[] = [];
  for (const [path, content] of files) {
    if (path.match(/^skills\/[^/]+\/SKILL\.md$/)) {
      skills.push({ name: basename(dirname(path)), content });
    }
  }

  const commands: PluginCommand[] = [];
  for (const [path, content] of files) {
    if (path.match(/^commands\/[^/]+\.md$/)) {
      commands.push({ name: basename(path, '.md'), content });
    }
  }

  const mcpServers: PluginMcpServer[] = [];
  const mcpContent = files.get('.mcp.json');
  if (mcpContent) {
    const parsed = McpJsonSchema.parse(JSON.parse(mcpContent));
    for (const [name, server] of Object.entries(parsed.mcpServers)) {
      mcpServers.push({ name, type: server.type, url: server.url });
    }
  }

  return { manifest, skills, commands, mcpServers };
}
