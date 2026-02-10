// src/cli/chat.ts
import { createInterface, type Interface } from 'node:readline';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { axHome } from '../paths.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ChatClientOptions {
  socketPath?: string;
  noStream?: boolean;
  stdin?: Readable;
  stdout?: Writable;
  fetch?: typeof fetch;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ═══════════════════════════════════════════════════════
// Chat Client
// ═══════════════════════════════════════════════════════

export function createChatClient(opts: ChatClientOptions = {}) {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');
  const stream = opts.noStream !== true;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  // Use injected fetch (tests) or create a Unix-socket-aware fetch
  const fetchFn = opts.fetch ?? createSocketFetch(socketPath);

  // Stable session ID for the lifetime of this chat client
  const sessionId = randomUUID();

  const messages: Message[] = [];

  async function start(): Promise<void> {
    const rl: Interface = createInterface({
      input: stdin,
      output: stdout,
      prompt: 'you> ',
    });

    let closed = false;
    rl.on('close', () => {
      closed = true;
    });

    rl.prompt();

    for await (const line of rl) {
      const content = line.trim();
      if (!content) {
        if (!closed) rl.prompt();
        continue;
      }

      // Add user message to history
      messages.push({ role: 'user', content });

      try {
        // Send request
        const response = await fetchFn(
          'http://localhost/v1/chat/completions',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'default',
              messages,
              stream,
              session_id: sessionId,
            }),
          },
        );

        if (!response.ok) {
          const error = await response.text();
          stdout.write(`Error: ${error}\n`);
          messages.pop(); // Remove failed user message
          if (!closed) rl.prompt();
          continue;
        }

        stdout.write('agent> ');

        if (stream && response.body) {
          const assistantContent = await handleStreamResponse(
            response.body,
            stdout,
          );
          messages.push({ role: 'assistant', content: assistantContent });
        } else {
          const data = await response.json();
          const assistantContent = data.choices[0].message.content;
          stdout.write(assistantContent);
          stdout.write('\n');
          messages.push({ role: 'assistant', content: assistantContent });
        }
      } catch {
        stdout.write(
          '\nServer not running. Start it with: ax serve\n',
        );
        messages.pop(); // Remove failed user message
      }

      if (!closed) rl.prompt();
    }

    if (!closed) rl.close();
  }

  return { start };
}

async function handleStreamResponse(
  body: ReadableStream<Uint8Array>,
  stdout: Writable,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            stdout.write('\n');
            return fullContent;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              stdout.write(content);
              fullContent += content;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  stdout.write('\n');
  return fullContent;
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
