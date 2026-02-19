import { describe, test, expect } from 'vitest';
import { historyToPiMessages, parseStdinPayload, type ConversationTurn } from '../../src/agent/runner.js';

describe('historyToPiMessages with sender', () => {
  test('prefixes user message content with sanitized sender', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hello', sender: 'alice_doe' },
      { role: 'assistant', content: 'hi there' },
    ];
    const messages = historyToPiMessages(history);
    expect(messages[0].content).toBe('[alice_doe]: hello');
    expect(messages[1]).toMatchObject({ role: 'assistant' });
  });

  test('does not prefix user message when sender is undefined', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hello' },
    ];
    const messages = historyToPiMessages(history);
    expect(messages[0].content).toBe('hello');
  });

  test('sanitizes sender: strips non-alphanumeric/underscore/dot/dash characters', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'test', sender: 'user<script>alert</script>' },
    ];
    const messages = historyToPiMessages(history);
    // After sanitization, only alphanumeric, underscore, dot, dash remain
    expect(messages[0].content).toBe('[userscriptalertscript]: test');
  });

  test('sanitizes sender with spaces and special chars', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'test', sender: 'John Doe @#$' },
    ];
    const messages = historyToPiMessages(history);
    expect(messages[0].content).toBe('[JohnDoe]: test');
  });

  test('does not prefix assistant messages even with sender', () => {
    const history: ConversationTurn[] = [
      { role: 'assistant', content: 'response', sender: 'bot' },
    ];
    const messages = historyToPiMessages(history);
    // Assistant messages use structured content, check the text
    const content = messages[0].content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('response');
  });

  test('empty sender after sanitization is treated as no sender', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'test', sender: '!@#$%^&*()' },
    ];
    const messages = historyToPiMessages(history);
    expect(messages[0].content).toBe('test');
  });

  test('sender with only valid characters passes through unchanged', () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: 'hi', sender: 'user.name-123_test' },
    ];
    const messages = historyToPiMessages(history);
    expect(messages[0].content).toBe('[user.name-123_test]: hi');
  });
});

describe('parseStdinPayload with sender', () => {
  test('preserves sender from history entries', () => {
    const payload = JSON.stringify({
      message: 'current message',
      history: [
        { role: 'user', content: 'hello', sender: 'alice' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    const result = parseStdinPayload(payload);
    expect(result.history[0].sender).toBe('alice');
    expect(result.history[1].sender).toBeUndefined();
  });

  test('handles history entries without sender', () => {
    const payload = JSON.stringify({
      message: 'msg',
      history: [
        { role: 'user', content: 'hello' },
      ],
    });
    const result = parseStdinPayload(payload);
    expect(result.history[0].sender).toBeUndefined();
  });
});
