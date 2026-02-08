import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { MessageQueue } from '../src/db.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue(':memory:');
  });

  afterEach(() => {
    queue.close();
  });

  test('enqueue returns an ID', () => {
    const id = queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'hello' });
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
  });

  test('dequeue returns oldest pending message', () => {
    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'first' });
    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'second' });

    const msg = queue.dequeue();
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('first');
    expect(msg!.status).toBe('processing');
  });

  test('dequeue returns null when empty', () => {
    expect(queue.dequeue()).toBeNull();
  });

  test('dequeue skips processing messages', () => {
    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'first' });
    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'second' });

    queue.dequeue(); // takes 'first', now 'processing'
    const msg = queue.dequeue(); // should take 'second'
    expect(msg!.content).toBe('second');
  });

  test('complete marks message as done', () => {
    const id = queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'hello' });
    queue.dequeue();
    queue.complete(id);

    // No more pending
    expect(queue.pending()).toBe(0);
    expect(queue.dequeue()).toBeNull();
  });

  test('fail marks message as error', () => {
    const id = queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'hello' });
    queue.dequeue();
    queue.fail(id);

    expect(queue.pending()).toBe(0);
  });

  test('pending returns count of pending messages', () => {
    expect(queue.pending()).toBe(0);

    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'a' });
    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'b' });
    expect(queue.pending()).toBe(2);

    queue.dequeue();
    expect(queue.pending()).toBe(1);
  });
});
