import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { compactHistory, type ConversationTurn } from '../../src/container/agent-runner.js';
import { IPCClient } from '../../src/container/ipc-client.js';

function createMockIPCServer(
  socketPath: string,
  handler: (req: Record<string, unknown>) => Record<string, unknown>,
): Server {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) break;
        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        buffer = buffer.subarray(4 + msgLen);
        const request = JSON.parse(raw);
        const response = handler(request);
        const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        socket.write(Buffer.concat([lenBuf, responseBuf]));
      }
    });
  });
  server.listen(socketPath);
  return server;
}

describe('compactHistory', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: Server;
  let client: IPCClient;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'compact-test-'));
    socketPath = join(tmpDir, 'test.sock');
  });

  afterEach(() => {
    client?.disconnect();
    server?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setupMockServer(summaryResponse: string) {
    server = createMockIPCServer(socketPath, (req) => {
      if (req.action === 'llm_call') {
        return {
          ok: true,
          chunks: [
            { type: 'text', content: summaryResponse },
            { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => server.on('listening', r));
    client = new IPCClient({ socketPath });
    await client.connect();
  }

  test('returns history unchanged when below threshold', async () => {
    await setupMockServer('');
    const history: ConversationTurn[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];

    const result = await compactHistory(history, client);
    expect(result).toEqual(history);
  });

  test('returns history unchanged when fewer than KEEP_RECENT_TURNS', async () => {
    await setupMockServer('');
    const history: ConversationTurn[] = [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'D' },
    ];

    const result = await compactHistory(history, client);
    expect(result).toEqual(history);
  });

  test('compacts long history when tokens exceed threshold', async () => {
    await setupMockServer('Summary: discussed project setup and config');

    // Create a history long enough to exceed 75% of a small context window
    const longText = 'x'.repeat(500);
    const history: ConversationTurn[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `Message ${i}: ${longText}` });
      history.push({ role: 'assistant', content: `Response ${i}: ${longText}` });
    }

    // Use a small context window to trigger compaction (500 chars ≈ 125 tokens per message,
    // 40 messages ≈ 5000 tokens, so threshold of 1000 will trigger)
    const result = await compactHistory(history, client, 1000);

    // Should have: summary pair + last 6 turns = 8 turns
    expect(result.length).toBe(8);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('Conversation summary');
    expect(result[0].content).toContain('Summary: discussed project setup and config');
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toContain('I understand the conversation context');

    // Recent turns preserved verbatim
    const lastOriginal = history.slice(-6);
    expect(result.slice(2)).toEqual(lastOriginal);
  });

  test('falls back to truncation when summarization fails', async () => {
    server = createMockIPCServer(socketPath, () => ({
      ok: false,
      error: 'LLM unavailable',
    }));
    await new Promise<void>((r) => server.on('listening', r));
    client = new IPCClient({ socketPath });
    await client.connect();

    const longText = 'x'.repeat(500);
    const history: ConversationTurn[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `Message ${i}: ${longText}` });
      history.push({ role: 'assistant', content: `Response ${i}: ${longText}` });
    }

    const result = await compactHistory(history, client, 1000);

    // Should fall back to just the recent turns
    expect(result.length).toBe(6);
    expect(result).toEqual(history.slice(-6));
  });

  test('falls back to truncation when summary is empty', async () => {
    await setupMockServer('   ');

    const longText = 'x'.repeat(500);
    const history: ConversationTurn[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `Message ${i}: ${longText}` });
      history.push({ role: 'assistant', content: `Response ${i}: ${longText}` });
    }

    const result = await compactHistory(history, client, 1000);
    expect(result.length).toBe(6);
    expect(result).toEqual(history.slice(-6));
  });

  test('sends correct summarization request via IPC', async () => {
    let capturedReq: Record<string, unknown> | null = null;
    server = createMockIPCServer(socketPath, (req) => {
      if (req.action === 'llm_call') {
        capturedReq = req;
        return {
          ok: true,
          chunks: [
            { type: 'text', content: 'A summary' },
            { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
          ],
        };
      }
      return { ok: true };
    });
    await new Promise<void>((r) => server.on('listening', r));
    client = new IPCClient({ socketPath });
    await client.connect();

    const longText = 'x'.repeat(500);
    const history: ConversationTurn[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: `Msg ${i}: ${longText}` });
      history.push({ role: 'assistant', content: `Resp ${i}: ${longText}` });
    }

    await compactHistory(history, client, 1000);

    expect(capturedReq).not.toBeNull();
    expect(capturedReq!.action).toBe('llm_call');
    const messages = capturedReq!.messages as any[];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('summarizer');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Summarize');
    // Should include old turns but not the last 6 (recent turns)
    expect(messages[1].content).toContain('Msg 0');
    expect(messages[1].content).not.toContain('Msg 9');
  });

  test('preserves summary count in compacted output', async () => {
    await setupMockServer('Key points from the conversation');

    const longText = 'x'.repeat(500);
    const history: ConversationTurn[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: `Msg ${i}: ${longText}` });
      history.push({ role: 'assistant', content: `Resp ${i}: ${longText}` });
    }

    const result = await compactHistory(history, client, 1000);

    // The summary message should mention how many messages were summarized
    // Old turns = 20 total - 6 recent = 14 old turns
    expect(result[0].content).toContain('14 earlier messages');
  });
});
