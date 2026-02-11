// src/cli/chat.ts
import React from 'react';
import { render } from 'ink';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { axHome } from '../paths.js';
import { App } from './components/App.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ChatClientOptions {
  socketPath?: string;
  noStream?: boolean;
  fetch?: typeof fetch;
}

// ═══════════════════════════════════════════════════════
// Chat Client
// ═══════════════════════════════════════════════════════

export function createChatClient(opts: ChatClientOptions = {}) {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');
  const stream = opts.noStream !== true;
  const fetchFn = opts.fetch ?? createSocketFetch(socketPath);
  const sessionId = randomUUID();

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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--no-stream') {
      noStream = true;
    }
  }

  const client = createChatClient({ socketPath, noStream });
  await client.start();
}
