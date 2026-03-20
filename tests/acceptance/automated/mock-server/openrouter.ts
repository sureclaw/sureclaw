import type { IncomingMessage, ServerResponse } from 'node:http';
import { ALL_TURNS, type ScriptedTurn } from '../scripted-turns.js';

let turnIndex = 0;

export function resetOpenRouter(): void {
  turnIndex = 0;
}

export function handleOpenRouter(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';

  if (url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ id: 'openrouter/google/gemini-3-flash-preview', object: 'model' }],
    }));
    return;
  }

  if (url.startsWith('/v1/chat/completions') && req.method === 'POST') {
    handleChatCompletion(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function handleChatCompletion(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages ?? [];

    // Find last user message
    let lastUserMsg = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content;
        lastUserMsg = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            : '';
        break;
      }
    }

    // Match against scripted turns - try from current index first, then search all
    let turn: ScriptedTurn | undefined;

    // First try matching from current position forward
    for (let i = turnIndex; i < ALL_TURNS.length; i++) {
      const t = ALL_TURNS[i];
      const match = typeof t.match === 'string'
        ? lastUserMsg.toLowerCase().includes(t.match.toLowerCase())
        : t.match.test(lastUserMsg);
      if (match) {
        turn = t;
        turnIndex = i + 1;
        break;
      }
    }

    // Fallback: search all turns
    if (!turn) {
      for (const t of ALL_TURNS) {
        const match = typeof t.match === 'string'
          ? lastUserMsg.toLowerCase().includes(t.match.toLowerCase())
          : t.match.test(lastUserMsg);
        if (match) {
          turn = t;
          break;
        }
      }
    }

    // Default response if no match
    if (!turn) {
      turn = {
        match: '',
        response: { content: 'I understand. How can I help you further?' },
      };
    }

    const isStreaming = body.stream === true;

    if (!isStreaming) {
      // Non-streaming response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: turn.response.content ?? null,
            tool_calls: turn.response.tool_calls ?? undefined,
          },
          finish_reason: turn.finishReason ?? (turn.response.tool_calls ? 'tool_calls' : 'stop'),
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
      return;
    }

    // Streaming SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const chatId = `chatcmpl-test-${Date.now()}`;

    // Initial role chunk
    sendSSE(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    // Content chunks (split into words for realistic streaming)
    if (turn.response.content) {
      const words = turn.response.content.split(' ');
      for (let i = 0; i < words.length; i++) {
        const word = (i > 0 ? ' ' : '') + words[i];
        sendSSE(res, {
          id: chatId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
        });
      }
    }

    // Tool call chunks
    if (turn.response.tool_calls) {
      for (let i = 0; i < turn.response.tool_calls.length; i++) {
        const tc = turn.response.tool_calls[i];
        // First chunk: function name
        sendSSE(res, {
          id: chatId,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: '' },
              }],
            },
            finish_reason: null,
          }],
        });
        // Second chunk: arguments
        sendSSE(res, {
          id: chatId,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                function: { arguments: tc.function.arguments },
              }],
            },
            finish_reason: null,
          }],
        });
      }
    }

    // Final chunk with finish reason
    const finishReason = turn.finishReason ?? (turn.response.tool_calls ? 'tool_calls' : 'stop');
    sendSSE(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    });

    res.write('data: [DONE]\n\n');
    res.end();
  });
}

function sendSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
