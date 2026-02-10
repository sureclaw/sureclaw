// src/cli/send.ts
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { Agent } from 'undici';
import { axHome } from '../paths.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface SendClientOptions {
  message: string;
  socketPath?: string;
  fromStdin?: boolean;
  stdin?: string;
  noStream?: boolean;
  json?: boolean;
  stdout?: Writable;
  fetch?: typeof fetch;
}

// ═══════════════════════════════════════════════════════
// Send Client
// ═══════════════════════════════════════════════════════

export function createSendClient(opts: SendClientOptions) {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');
  const stream = opts.noStream !== true && !opts.json;
  const stdout = opts.stdout ?? process.stdout;
  const fetchFn = opts.fetch ?? createSocketFetch(socketPath);
  const message = opts.message;

  async function send(): Promise<void> {
    const response = await fetchFn(
      'http://localhost/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: message }],
          stream,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Server error: ${error}`);
    }

    if (opts.json) {
      const data = await response.json();
      stdout.write(JSON.stringify(data, null, 2));
      return;
    }

    if (stream && response.body) {
      await handleStreamResponse(response.body, stdout);
    } else {
      const data = await response.json();
      stdout.write(data.choices[0].message.content);
    }
  }

  return { send };
}

async function handleStreamResponse(
  body: ReadableStream<Uint8Array>,
  stdout: Writable,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

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
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              stdout.write(content);
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

export async function runSend(args: string[]): Promise<void> {
  let socketPath: string | undefined;
  let noStream = false;
  let json = false;
  let fromStdin = false;
  let message = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--no-stream') {
      noStream = true;
    } else if (args[i] === '--json') {
      json = true;
    } else if (args[i] === '--stdin' || args[i] === '-') {
      fromStdin = true;
    } else if (!message) {
      message = args[i];
    }
  }

  if (fromStdin) {
    const { stdin } = process;
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(chunk);
    }
    message = Buffer.concat(chunks).toString('utf-8');
  }

  if (!message) {
    console.error('Error: message required (provide as argument or use --stdin)');
    process.exit(1);
  }

  const client = createSendClient({
    message,
    socketPath,
    noStream,
    json,
    fromStdin,
  });

  try {
    await client.send();
    process.exit(0);
  } catch (err) {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  }
}
