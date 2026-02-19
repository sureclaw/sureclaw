// src/cli/chat.ts
import React from 'react';
import { render } from 'ink';
import { join } from 'node:path';
import { Agent } from 'undici';
import { axHome, composeSessionId } from '../paths.js';
import { App } from './components/App.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ChatClientOptions {
  socketPath?: string;
  noStream?: boolean;
  sessionId?: string;
  fetch?: typeof fetch;
}

// ═══════════════════════════════════════════════════════
// Chat Client
// ═══════════════════════════════════════════════════════

export function createChatClient(opts: ChatClientOptions = {}) {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');
  const stream = opts.noStream !== true;
  const fetchFn = opts.fetch ?? createSocketFetch(socketPath);
  const sessionId = opts.sessionId ?? composeSessionId('main', 'cli', 'default');

  async function start(): Promise<void> {
    const { waitUntilExit } = render(
      React.createElement(App, {
        fetchFn,
        sessionId,
        stream,
      })
    );
    await waitUntilExit();
  }

  return { start };
}

// ═══════════════════════════════════════════════════════
// Unix Socket Fetch
// ═══════════════════════════════════════════════════════

function createSocketFetch(socketPath: string): typeof fetch {
  const dispatcher = new Agent({ connect: { socketPath } });
  return (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, dispatcher } as RequestInit);
}

// ═══════════════════════════════════════════════════════
// CLI Entry Point
// ═══════════════════════════════════════════════════════

export async function runChat(args: string[]): Promise<void> {
  let socketPath: string | undefined;
  let noStream = false;
  let sessionName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--no-stream') {
      noStream = true;
    } else if (args[i] === '--session') {
      sessionName = args[++i];
    }
  }

  // If --session given and doesn't contain ':', compose as main:cli:<name>
  // If it contains ':', pass through as full session ID
  const sessionId = sessionName
    ? (sessionName.includes(':') ? sessionName : composeSessionId('main', 'cli', sessionName))
    : undefined; // falls back to default in createChatClient

  const client = createChatClient({ socketPath, noStream, sessionId });
  await client.start();
}
