import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ChannelProvider, InboundMessage, OutboundMessage, Config } from '../types.js';

export async function create(_config: Config): Promise<ChannelProvider> {
  let rl: Interface | null = null;
  let messageHandler: ((msg: InboundMessage) => void) | null = null;

  return {
    name: 'cli',

    async connect(): Promise<void> {
      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'you> ',
      });

      rl.on('line', (line: string) => {
        const content = line.trim();
        if (!content) return;

        if (messageHandler) {
          messageHandler({
            id: randomUUID(),
            channel: 'cli',
            sender: 'user',
            content,
            timestamp: new Date(),
            isGroup: false,
          });
        }
      });

      rl.prompt();
    },

    onMessage(handler: (msg: InboundMessage) => void): void {
      messageHandler = handler;
    },

    async send(_target: string, content: OutboundMessage): Promise<void> {
      process.stdout.write(`agent> ${content.content}\n`);
      rl?.prompt();
    },

    async disconnect(): Promise<void> {
      rl?.close();
      rl = null;
    },
  };
}
