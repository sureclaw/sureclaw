import { describe, it, expect, vi } from 'vitest';
import { createCompletionQueue, type CompletionQueue } from '../../src/host/completion-queue.js';
import { createEventBus, type EventBus } from '../../src/host/event-bus.js';

describe('CompletionQueue', () => {
  describe('createCompletionQueue', () => {
    it('returns an object with the expected API', () => {
      const queue = createCompletionQueue();
      expect(typeof queue.enqueue).toBe('function');
      expect(typeof queue.activeCount).toBe('function');
      expect(typeof queue.waitingCount).toBe('function');
      expect(typeof queue.drain).toBe('function');
    });

    it('starts with zero active and zero waiting', () => {
      const queue = createCompletionQueue();
      expect(queue.activeCount()).toBe(0);
      expect(queue.waitingCount()).toBe(0);
    });
  });

  describe('immediate slot acquisition', () => {
    it('grants a slot immediately when under capacity', () => {
      const queue = createCompletionQueue({ maxConcurrent: 2 });
      const ticket = queue.enqueue('req-1');
      expect(ticket).not.toBeNull();
      expect(ticket!.position).toBe(0);
      expect(queue.activeCount()).toBe(1);
    });

    it('grants multiple slots up to maxConcurrent', () => {
      const queue = createCompletionQueue({ maxConcurrent: 3 });
      const t1 = queue.enqueue('req-1');
      const t2 = queue.enqueue('req-2');
      const t3 = queue.enqueue('req-3');
      expect(t1).not.toBeNull();
      expect(t2).not.toBeNull();
      expect(t3).not.toBeNull();
      expect(queue.activeCount()).toBe(3);
      expect(queue.waitingCount()).toBe(0);
    });

    it('ready promise resolves immediately for direct slots', async () => {
      const queue = createCompletionQueue({ maxConcurrent: 2 });
      const ticket = queue.enqueue('req-1')!;
      // Should resolve without delay
      await ticket.ready;
      expect(queue.activeCount()).toBe(1);
    });
  });

  describe('queuing behavior', () => {
    it('queues requests when at capacity', async () => {
      const queue = createCompletionQueue({ maxConcurrent: 1, maxQueueDepth: 10 });

      const t1 = queue.enqueue('req-1')!;
      await t1.ready;
      expect(queue.activeCount()).toBe(1);

      const t2 = queue.enqueue('req-2')!;
      expect(t2.position).toBe(1);
      expect(queue.waitingCount()).toBe(1);
      expect(queue.activeCount()).toBe(1);

      // Release first slot — second should get it
      t1.done();

      await t2.ready;
      expect(queue.activeCount()).toBe(1);
      expect(queue.waitingCount()).toBe(0);

      t2.done();
      expect(queue.activeCount()).toBe(0);
    });

    it('processes queued requests in FIFO order', async () => {
      const queue = createCompletionQueue({ maxConcurrent: 1, maxQueueDepth: 10 });
      const order: string[] = [];

      const t1 = queue.enqueue('req-1')!;
      await t1.ready;

      const t2 = queue.enqueue('req-2')!;
      const t3 = queue.enqueue('req-3')!;

      // Track order of resolution
      t2.ready.then(() => order.push('req-2'));
      t3.ready.then(() => order.push('req-3'));

      // Release first — should wake req-2 first
      t1.done();
      await t2.ready;
      t2.done();
      await t3.ready;
      t3.done();

      expect(order).toEqual(['req-2', 'req-3']);
    });

    it('rejects when queue is full', () => {
      const queue = createCompletionQueue({ maxConcurrent: 1, maxQueueDepth: 2 });

      const t1 = queue.enqueue('req-1')!;
      expect(t1).not.toBeNull();

      const t2 = queue.enqueue('req-2')!;
      const t3 = queue.enqueue('req-3')!;
      expect(t2).not.toBeNull();
      expect(t3).not.toBeNull();
      expect(queue.waitingCount()).toBe(2);

      // Queue is now full (2 waiters)
      const t4 = queue.enqueue('req-4');
      expect(t4).toBeNull();

      // Cleanup
      t1.done();
    });
  });

  describe('slot release', () => {
    it('done() is idempotent', () => {
      const queue = createCompletionQueue({ maxConcurrent: 2 });
      const ticket = queue.enqueue('req-1')!;
      expect(queue.activeCount()).toBe(1);

      ticket.done();
      expect(queue.activeCount()).toBe(0);

      // Second call should be no-op
      ticket.done();
      expect(queue.activeCount()).toBe(0);
    });

    it('releases slot back to pool after done()', async () => {
      const queue = createCompletionQueue({ maxConcurrent: 1 });

      const t1 = queue.enqueue('req-1')!;
      await t1.ready;
      expect(queue.activeCount()).toBe(1);

      t1.done();
      expect(queue.activeCount()).toBe(0);

      // Should be able to enqueue again
      const t2 = queue.enqueue('req-2')!;
      expect(t2).not.toBeNull();
      expect(t2.position).toBe(0);
      t2.done();
    });
  });

  describe('abort signal', () => {
    it('removes waiter from queue when signal aborts', async () => {
      const queue = createCompletionQueue({ maxConcurrent: 1, maxQueueDepth: 10 });

      const t1 = queue.enqueue('req-1')!;
      await t1.ready;

      const abortController = new AbortController();
      const t2 = queue.enqueue('req-2', abortController.signal)!;
      expect(queue.waitingCount()).toBe(1);

      // Abort while waiting
      abortController.abort();

      // The ready promise should reject
      await expect(t2.ready).rejects.toThrow('cancelled');
      expect(queue.waitingCount()).toBe(0);

      t1.done();
    });
  });

  describe('drain', () => {
    it('rejects new enqueues after drain', () => {
      const queue = createCompletionQueue({ maxConcurrent: 2 });
      queue.drain();

      const ticket = queue.enqueue('req-1');
      expect(ticket).toBeNull();
    });

    it('resolves existing waiters on drain', async () => {
      const queue = createCompletionQueue({ maxConcurrent: 1, maxQueueDepth: 10 });

      const t1 = queue.enqueue('req-1')!;
      await t1.ready;

      const t2 = queue.enqueue('req-2')!;
      expect(queue.waitingCount()).toBe(1);

      // Drain should resolve the waiter
      queue.drain();
      await t2.ready;
      expect(queue.waitingCount()).toBe(0);

      t1.done();
      t2.done();
    });
  });

  describe('event bus integration', () => {
    it('emits queue.started for immediate slot', () => {
      const bus = createEventBus();
      const events: any[] = [];
      bus.subscribe((e) => events.push(e));

      const queue = createCompletionQueue({ maxConcurrent: 2 }, bus);
      queue.enqueue('req-1');

      const started = events.find(e => e.type === 'queue.started');
      expect(started).toBeDefined();
      expect(started.requestId).toBe('req-1');
      expect(started.data.waitMs).toBe(0);
    });

    it('emits queue.enqueued when request must wait', async () => {
      const bus = createEventBus();
      const events: any[] = [];
      bus.subscribe((e) => events.push(e));

      const queue = createCompletionQueue({ maxConcurrent: 1, maxQueueDepth: 10 }, bus);
      const t1 = queue.enqueue('req-1')!;
      await t1.ready;

      queue.enqueue('req-2');

      const enqueued = events.find(e => e.type === 'queue.enqueued');
      expect(enqueued).toBeDefined();
      expect(enqueued.requestId).toBe('req-2');
      expect(enqueued.data.position).toBe(1);

      t1.done();
    });

    it('emits queue.rejected when queue is full', () => {
      const bus = createEventBus();
      const events: any[] = [];
      bus.subscribe((e) => events.push(e));

      const queue = createCompletionQueue({ maxConcurrent: 1, maxQueueDepth: 0 }, bus);
      queue.enqueue('req-1');
      queue.enqueue('req-2'); // Should be rejected

      const rejected = events.find(e => e.type === 'queue.rejected');
      expect(rejected).toBeDefined();
      expect(rejected.requestId).toBe('req-2');
    });

    it('emits queue.done when slot is released', async () => {
      const bus = createEventBus();
      const events: any[] = [];
      bus.subscribe((e) => events.push(e));

      const queue = createCompletionQueue({ maxConcurrent: 2 }, bus);
      const t1 = queue.enqueue('req-1')!;
      await t1.ready;

      t1.done();

      const done = events.find(e => e.type === 'queue.done');
      expect(done).toBeDefined();
      expect(done.requestId).toBe('req-1');
    });
  });

  describe('concurrent stress', () => {
    it('handles 20 concurrent requests with maxConcurrent=3', async () => {
      const queue = createCompletionQueue({ maxConcurrent: 3, maxQueueDepth: 100 });
      const tickets: { ticket: ReturnType<typeof queue.enqueue>; id: string }[] = [];

      for (let i = 0; i < 20; i++) {
        const t = queue.enqueue(`req-${i}`);
        expect(t).not.toBeNull();
        tickets.push({ ticket: t!, id: `req-${i}` });
      }

      expect(queue.activeCount()).toBe(3);
      expect(queue.waitingCount()).toBe(17);

      // Process all tickets
      for (const { ticket } of tickets) {
        await ticket!.ready;
        ticket!.done();
      }

      expect(queue.activeCount()).toBe(0);
      expect(queue.waitingCount()).toBe(0);
    });
  });
});
