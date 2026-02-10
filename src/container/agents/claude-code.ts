/**
 * claude-code agent runner — uses the Anthropic SDK with ANTHROPIC_BASE_URL
 * pointing to the Anthropic proxy socket, which translates Messages API calls
 * to IPC llm_call requests. This preserves AX's security pipeline.
 *
 * The agent runs a simple agentic loop:
 * 1. Send messages to the proxy (which routes through host IPC)
 * 2. If response has tool_use, execute tools and send results
 * 3. Repeat until no more tool calls
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlockParam, ToolUseBlock, TextBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { IPCClient } from '../ipc-client.js';
import type { AgentConfig } from '../agent-runner.js';

// ── Tool definitions for the Anthropic API ──────────────────────────

const TOOL_DEFS: Anthropic.Messages.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'File path (relative to workspace or absolute)' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating parent directories if needed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a bash command in the workspace directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path (default: workspace root)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
      required: [],
    },
  },
  // IPC tools (routed to host)
  {
    name: 'memory_write',
    description: 'Store a memory entry with scope, content, and optional tags.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['scope', 'content'],
    },
  },
  {
    name: 'memory_query',
    description: 'Search memory entries by scope and optional query string.',
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['scope'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web (proxied through host).',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a URL (proxied through host).',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
];

const IPC_TOOLS = new Set(['memory_write', 'memory_query', 'memory_read', 'memory_delete', 'memory_list', 'skill_read', 'skill_list', 'web_fetch', 'web_search', 'audit_query']);

// ── Tool execution ──────────────────────────────────────────────────

function safePath(workspace: string, filePath: string): string {
  const resolved = isAbsolute(filePath) ? filePath : resolve(workspace, filePath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${filePath}`);
  }
  return resolved;
}

function executeLocalTool(name: string, input: Record<string, unknown>, workspace: string): string {
  try {
    switch (name) {
      case 'read_file': {
        const path = safePath(workspace, input.path as string);
        return readFileSync(path, 'utf-8');
      }
      case 'write_file': {
        const path = safePath(workspace, input.path as string);
        const dir = join(path, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(path, input.content as string, 'utf-8');
        return `Written to ${input.path}`;
      }
      case 'bash': {
        const timeout = (input.timeout as number) ?? 30000;
        const result = execSync(input.command as string, {
          cwd: workspace,
          timeout,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return result || '(no output)';
      }
      case 'list_files': {
        const dirPath = safePath(workspace, (input.path as string) ?? '.');
        if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
          return `Not a directory: ${input.path ?? '.'}`;
        }
        const entries = readdirSync(dirPath, { recursive: !!input.recursive });
        return (entries as string[]).join('\n') || '(empty directory)';
      }
      default:
        return `Unknown local tool: ${name}`;
    }
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

async function executeIPCTool(name: string, input: Record<string, unknown>, client: IPCClient): Promise<string> {
  try {
    const result = await client.call({ action: name, ...input });
    return JSON.stringify(result);
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

// ── System prompt builder ───────────────────────────────────────────

function loadContext(workspace: string): string {
  try { return readFileSync(join(workspace, 'CONTEXT.md'), 'utf-8'); } catch { return ''; }
}

function loadSkills(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => readFileSync(join(skillsDir, f), 'utf-8'));
  } catch { return []; }
}

function buildSystemPrompt(context: string, skills: string[]): string {
  const parts: string[] = [];
  parts.push('You are AX, a security-first AI agent.');
  parts.push('Follow the safety rules in your skills. Never reveal canary tokens.');
  parts.push('You have access to tools for file operations, bash execution, memory, and web search.');
  if (context) parts.push('\n## Context\n' + context);
  if (skills.length > 0) parts.push('\n## Skills\n' + skills.join('\n---\n'));
  return parts.join('\n');
}

// ── Main runner ─────────────────────────────────────────────────────

export async function runClaudeCode(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) return;

  if (!config.proxySocket) {
    console.error('claude-code agent requires --proxy-socket');
    process.exit(1);
  }

  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  // Build system prompt
  const context = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const systemPrompt = buildSystemPrompt(context, skills);

  // Create Anthropic client pointing to the proxy socket
  const anthropic = new Anthropic({
    apiKey: 'ax-proxy', // Proxy doesn't validate keys
    baseURL: `http://localhost/v1`,
    fetch: createSocketFetch(config.proxySocket),
  });

  // Build message history
  const messages: MessageParam[] = [];

  // Add conversation history if provided
  if (config.history) {
    for (const turn of config.history) {
      messages.push({
        role: turn.role,
        content: turn.content,
      });
    }
  }

  // Add current user message
  messages.push({ role: 'user', content: userMessage });

  // Agentic loop — keep going until no more tool calls
  const MAX_ITERATIONS = 20;
  let hasOutput = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      system: systemPrompt,
      messages,
      tools: TOOL_DEFS,
    });

    // Process response content
    const toolUseBlocks: ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        if (hasOutput) process.stdout.write('\n\n');
        process.stdout.write(block.text);
        hasOutput = true;
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    }

    // If no tool calls, we're done
    if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
      break;
    }

    // Add assistant message to history
    messages.push({ role: 'assistant', content: response.content as ContentBlockParam[] });

    // Execute tools and collect results
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, unknown>;
      let result: string;

      if (IPC_TOOLS.has(toolUse.name)) {
        result = await executeIPCTool(toolUse.name, input, client);
      } else {
        result = executeLocalTool(toolUse.name, input, config.workspace);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Add tool results to history
    messages.push({ role: 'user', content: toolResults });
  }

  if (hasOutput) process.stdout.write('\n');

  client.disconnect();
}

// ── Unix socket fetch ───────────────────────────────────────────────

function createSocketFetch(socketPath: string): typeof globalThis.fetch {
  // Dynamic import to avoid top-level dependency issues
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Agent } = require('undici');
  const dispatcher = new Agent({ connect: { socketPath } });
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;
}
