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

  test('dequeueById returns the specific message', () => {
    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'first' });
    const id2 = queue.enqueue({ sessionId: 's2', channel: 'cli', sender: 'user', content: 'second' });
    queue.enqueue({ sessionId: 's3', channel: 'cli', sender: 'user', content: 'third' });

    // Should get the second message, skipping the first
    const msg = queue.dequeueById(id2);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe('second');
    expect(msg!.session_id).toBe('s2');
    expect(msg!.status).toBe('processing');

    // First and third are still pending
    expect(queue.pending()).toBe(2);
  });

  test('dequeueById returns null for non-existent ID', () => {
    queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'hello' });
    expect(queue.dequeueById('non-existent-id')).toBeNull();
  });

  test('dequeueById returns null for already-processed message', () => {
    const id = queue.enqueue({ sessionId: 's1', channel: 'cli', sender: 'user', content: 'hello' });
    queue.dequeueById(id); // now 'processing'
    expect(queue.dequeueById(id)).toBeNull(); // can't dequeue again
  });
});

