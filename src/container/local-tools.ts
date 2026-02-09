import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }], details: undefined };
}

/** Ensure path stays within workspace. Returns resolved absolute path or null. */
function safePath(workspace: string, relPath: string): string | null {
  const abs = resolve(workspace, relPath);
  const rel = relative(workspace, abs);
  if (rel.startsWith('..') || resolve(rel) === rel) return null;
  return abs;
}

export function createLocalTools(workspace: string): AgentTool[] {
  return [
    {
      name: 'bash',
      label: 'Run Command',
      description: 'Execute a bash command in the workspace directory.',
      parameters: Type.Object({
        command: Type.String({ description: 'The bash command to execute' }),
      }),
      async execute(_toolCallId, params) {
        try {
          const out = execSync(params.command, {
            cwd: workspace,
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return text(out);
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; status?: number };
          const output = [e.stdout, e.stderr].filter(Boolean).join('\n') || 'Command failed';
          return text(`Exit code ${e.status ?? 1}\n${output}`);
        }
      },
    },
    {
      name: 'read_file',
      label: 'Read File',
      description: 'Read the contents of a file in the workspace.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path to the file' }),
      }),
      async execute(_toolCallId, params) {
        const abs = safePath(workspace, params.path);
        if (!abs) return text('Error: path outside workspace');
        try {
          return text(readFileSync(abs, 'utf-8'));
        } catch {
          return text(`Error: file not found: ${params.path}`);
        }
      },
    },
    {
      name: 'write_file',
      label: 'Write File',
      description: 'Write content to a file in the workspace.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path to the file' }),
        content: Type.String({ description: 'Content to write' }),
      }),
      async execute(_toolCallId, params) {
        const abs = safePath(workspace, params.path);
        if (!abs) return text('Error: path outside workspace');
        try {
          mkdirSync(resolve(abs, '..'), { recursive: true });
          writeFileSync(abs, params.content, 'utf-8');
          return text(`Written: ${params.path}`);
        } catch (err: unknown) {
          return text(`Error writing file: ${(err as Error).message}`);
        }
      },
    },
    {
      name: 'edit_file',
      label: 'Edit File',
      description: 'Replace a string in a file.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative path to the file' }),
        old_string: Type.String({ description: 'Text to find' }),
        new_string: Type.String({ description: 'Replacement text' }),
      }),
      async execute(_toolCallId, params) {
        const abs = safePath(workspace, params.path);
        if (!abs) return text('Error: path outside workspace');
        try {
          const content = readFileSync(abs, 'utf-8');
          if (!content.includes(params.old_string)) {
            return text('Error: old_string not found in file');
          }
          writeFileSync(abs, content.replace(params.old_string, params.new_string), 'utf-8');
          return text(`Edited: ${params.path}`);
        } catch (err: unknown) {
          return text(`Error editing file: ${(err as Error).message}`);
        }
      },
    },
  ];
}
