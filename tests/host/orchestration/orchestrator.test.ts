import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEventBus, type StreamEvent, type EventBus } from '../../../src/host/event-bus.js';
import { createOrchestrator, type Orchestrator } from '../../../src/host/orchestration/orchestrator.js';
import type { AgentRegistration, AgentMessage } from '../../../src/host/orchestration/types.js';

function makeRegistration(overrides: Partial<AgentRegistration> = {}): AgentRegistration {
  return {
    agentId: 'main',
    agentType: 'pi-coding-agent',
    sessionId: 'session-1',
    userId: 'user-1',
    ...overrides,
  };
}

describe('Orchestrator', () => {
  let eventBus: EventBus;
  let orchestrator: Orchestrator;
  let events: StreamEvent[];

  beforeEach(() => {
    eventBus = createEventBus();
    events = [];
    eventBus.subscribe(e => events.push(e));
    orchestrator = createOrchestrator(eventBus);
  });

  describe('register', () => {
    it('delegates to supervisor and returns a handle', () => {
      const handle = orchestrator.register(makeRegistration());
      expect(handle.agentId).toBe('main');
      expect(handle.state).toBe('spawning');
      expect(orchestrator.supervisor.get(handle.id)).toBe(handle);
    });
  });

  describe('send', () => {
    it('delivers a message from sender to recipient', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      const msg = orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { text: 'hello' },
      });

      expect(msg.id).toBeDefined();
      expect(msg.from).toBe(sender.id);
      expect(msg.to).toBe(recipient.id);
      expect(msg.type).toBe('notification');
      expect(msg.payload).toEqual({ text: 'hello' });
    });

    it('emits agent.message event', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));
      events.length = 0;

      orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { test: true },
      });

      const msgEvent = events.find(e => e.type === 'agent.message');
      expect(msgEvent).toBeDefined();
      expect(msgEvent!.data.from).toBe(sender.id);
      expect(msgEvent!.data.to).toBe(recipient.id);
    });

    it('throws if sender not found', () => {
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));
      expect(() =>
        orchestrator.send('nonexistent', recipient.id, {
          type: 'notification',
          payload: {},
        })
      ).toThrow('Sender agent nonexistent not found');
    });

    it('throws if recipient not found', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      expect(() =>
        orchestrator.send(sender.id, 'nonexistent', {
          type: 'notification',
          payload: {},
        })
      ).toThrow('Recipient agent nonexistent not found');
    });

    it('throws if sender is in terminal state', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      orchestrator.supervisor.complete(sender.id);
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      expect(() =>
        orchestrator.send(sender.id, recipient.id, {
          type: 'notification',
          payload: {},
        })
      ).toThrow('terminal state');
    });

    it('throws if payload exceeds max size', () => {
      const orch = createOrchestrator(eventBus, undefined, { maxMessagePayloadBytes: 100 });
      const sender = orch.register(makeRegistration({ agentId: 'sender' }));
      orch.supervisor.transition(sender.id, 'running');
      const recipient = orch.register(makeRegistration({ agentId: 'recipient' }));

      expect(() =>
        orch.send(sender.id, recipient.id, {
          type: 'notification',
          payload: { data: 'x'.repeat(200) },
        })
      ).toThrow('payload exceeds max size');
    });

    it('supports correlation IDs for request/response', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      const msg = orchestrator.send(sender.id, recipient.id, {
        type: 'request',
        payload: { question: 'What is 2+2?' },
        correlationId: 'corr-123',
      });

      expect(msg.correlationId).toBe('corr-123');
    });
  });

  describe('broadcast', () => {
    it('sends to all agents in session scope', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender', sessionId: 'sess-1' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      orchestrator.register(makeRegistration({ agentId: 'a', sessionId: 'sess-1' }));
      orchestrator.register(makeRegistration({ agentId: 'b', sessionId: 'sess-1' }));
      orchestrator.register(makeRegistration({ agentId: 'c', sessionId: 'sess-2' }));

      const messages = orchestrator.broadcast(
        sender.id,
        { type: 'session', sessionId: 'sess-1' },
        { type: 'notification', payload: { text: 'hello all' } },
      );

      // Should send to a and b (not sender, not c which is in different session)
      expect(messages).toHaveLength(2);
    });

    it('excludes sender from broadcast', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender', sessionId: 'sess-1' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      orchestrator.register(makeRegistration({ agentId: 'other', sessionId: 'sess-1' }));

      const messages = orchestrator.broadcast(
        sender.id,
        { type: 'session', sessionId: 'sess-1' },
        { type: 'notification', payload: {} },
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].to).not.toBe(sender.id);
    });

    it('excludes terminal agents from broadcast', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const done = orchestrator.register(makeRegistration({ agentId: 'done' }));
      orchestrator.supervisor.transition(done.id, 'running');
      orchestrator.supervisor.complete(done.id);
      orchestrator.register(makeRegistration({ agentId: 'active' }));

      const messages = orchestrator.broadcast(
        sender.id,
        { type: 'session', sessionId: 'session-1' },
        { type: 'notification', payload: {} },
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].to).not.toBe(done.id);
    });

    it('sends to children scope', () => {
      const parent = orchestrator.register(makeRegistration({ agentId: 'parent' }));
      orchestrator.supervisor.transition(parent.id, 'running');
      orchestrator.register(makeRegistration({ agentId: 'child-1', parentId: parent.id }));
      orchestrator.register(makeRegistration({ agentId: 'child-2', parentId: parent.id }));
      orchestrator.register(makeRegistration({ agentId: 'unrelated' }));

      const messages = orchestrator.broadcast(
        parent.id,
        { type: 'children', parentId: parent.id },
        { type: 'notification', payload: { msg: 'kids, listen up' } },
      );

      expect(messages).toHaveLength(2);
    });
  });

  describe('onMessage / pollMessages', () => {
    it('push-delivers messages to listeners', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      const received: AgentMessage[] = [];
      orchestrator.onMessage(recipient.id, msg => received.push(msg));

      orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { text: 'pushed' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({ text: 'pushed' });
    });

    it('pull-delivers messages via poll', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { text: 'msg-1' },
      });
      orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { text: 'msg-2' },
      });

      const messages = orchestrator.pollMessages(recipient.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].payload).toEqual({ text: 'msg-1' });
      expect(messages[1].payload).toEqual({ text: 'msg-2' });

      // Polling again should return empty (messages drained)
      expect(orchestrator.pollMessages(recipient.id)).toHaveLength(0);
    });

    it('poll respects limit', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      for (let i = 0; i < 5; i++) {
        orchestrator.send(sender.id, recipient.id, {
          type: 'notification',
          payload: { idx: i },
        });
      }

      const batch1 = orchestrator.pollMessages(recipient.id, 2);
      expect(batch1).toHaveLength(2);

      const batch2 = orchestrator.pollMessages(recipient.id, 10);
      expect(batch2).toHaveLength(3); // Remaining 3
    });

    it('unsubscribe stops push delivery', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      const received: AgentMessage[] = [];
      const unsub = orchestrator.onMessage(recipient.id, msg => received.push(msg));

      orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { text: 'before' },
      });

      unsub();

      orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { text: 'after' },
      });

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({ text: 'before' });
    });

    it('drops oldest message when mailbox overflows', () => {
      const orch = createOrchestrator(eventBus, undefined, { maxMailboxSize: 3 });
      const sender = orch.register(makeRegistration({ agentId: 'sender' }));
      orch.supervisor.transition(sender.id, 'running');
      const recipient = orch.register(makeRegistration({ agentId: 'recipient' }));

      for (let i = 0; i < 5; i++) {
        orch.send(sender.id, recipient.id, {
          type: 'notification',
          payload: { idx: i },
        });
      }

      const messages = orch.pollMessages(recipient.id);
      expect(messages).toHaveLength(3);
      // Oldest two (idx 0, 1) should have been dropped
      expect(messages[0].payload).toEqual({ idx: 2 });
      expect(messages[1].payload).toEqual({ idx: 3 });
      expect(messages[2].payload).toEqual({ idx: 4 });
    });

    it('returns empty array for unknown handle', () => {
      expect(orchestrator.pollMessages('nonexistent')).toHaveLength(0);
    });
  });

  describe('query', () => {
    it('returns snapshots matching filter', () => {
      const a = orchestrator.register(makeRegistration({ agentId: 'a', userId: 'alice' }));
      orchestrator.supervisor.transition(a.id, 'running');
      orchestrator.register(makeRegistration({ agentId: 'b', userId: 'bob' }));

      const results = orchestrator.query({ userId: 'alice' });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('a');
      expect(results[0].state).toBe('running');
      expect(typeof results[0].durationMs).toBe('number');
    });

    it('returns all agents without filter', () => {
      orchestrator.register(makeRegistration({ agentId: 'a' }));
      orchestrator.register(makeRegistration({ agentId: 'b' }));
      expect(orchestrator.query({})).toHaveLength(2);
    });
  });

  describe('tree', () => {
    it('returns agent tree', () => {
      const root = orchestrator.register(makeRegistration({ agentId: 'root' }));
      orchestrator.register(makeRegistration({ agentId: 'child', parentId: root.id }));

      const tree = orchestrator.tree(root.id);
      expect(tree).not.toBeNull();
      expect(tree!.handle.agentId).toBe('root');
      expect(tree!.children).toHaveLength(1);
      expect(tree!.children[0].handle.agentId).toBe('child');
    });

    it('returns null for unknown root', () => {
      expect(orchestrator.tree('nonexistent')).toBeNull();
    });
  });

  describe('enableAutoState', () => {
    it('transitions to waiting_for_llm on llm.start event', () => {
      const handle = orchestrator.register(makeRegistration());
      orchestrator.supervisor.transition(handle.id, 'running');
      const unsub = orchestrator.enableAutoState();

      eventBus.emit({
        type: 'llm.start',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: { model: 'claude-3-opus' },
      });

      expect(orchestrator.supervisor.get(handle.id)?.state).toBe('waiting_for_llm');
      unsub();
    });

    it('transitions to thinking on llm.thinking event', () => {
      const handle = orchestrator.register(makeRegistration());
      orchestrator.supervisor.transition(handle.id, 'running');
      const unsub = orchestrator.enableAutoState();

      eventBus.emit({
        type: 'llm.start',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: {},
      });

      eventBus.emit({
        type: 'llm.thinking',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: { contentLength: 100 },
      });

      expect(orchestrator.supervisor.get(handle.id)?.state).toBe('thinking');
      unsub();
    });

    it('transitions to tool_calling on tool.call event', () => {
      const handle = orchestrator.register(makeRegistration());
      orchestrator.supervisor.transition(handle.id, 'running');
      const unsub = orchestrator.enableAutoState();

      eventBus.emit({
        type: 'tool.call',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: { toolName: 'bash' },
      });

      expect(orchestrator.supervisor.get(handle.id)?.state).toBe('tool_calling');
      unsub();
    });

    it('transitions back to running on llm.done event', () => {
      const handle = orchestrator.register(makeRegistration());
      orchestrator.supervisor.transition(handle.id, 'running');
      const unsub = orchestrator.enableAutoState();

      eventBus.emit({
        type: 'llm.start',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: {},
      });
      eventBus.emit({
        type: 'llm.done',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: { chunkCount: 10 },
      });

      expect(orchestrator.supervisor.get(handle.id)?.state).toBe('running');
      unsub();
    });

    it('transitions spawning to running on completion.agent event', () => {
      const handle = orchestrator.register(makeRegistration());
      // handle starts in spawning
      const unsub = orchestrator.enableAutoState();

      eventBus.emit({
        type: 'completion.agent',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: { agentType: 'pi-coding-agent', attempt: 0, sessionId: handle.sessionId },
      });

      expect(orchestrator.supervisor.get(handle.id)?.state).toBe('running');
      unsub();
    });

    it('ignores events for unknown sessions', () => {
      orchestrator.enableAutoState();

      // Should not throw
      eventBus.emit({
        type: 'llm.start',
        requestId: 'unknown-session',
        timestamp: Date.now(),
        data: {},
      });
    });

    it('ignores events for terminal agents', () => {
      const handle = orchestrator.register(makeRegistration());
      orchestrator.supervisor.transition(handle.id, 'running');
      orchestrator.supervisor.complete(handle.id);
      const unsub = orchestrator.enableAutoState();

      // Should not throw
      eventBus.emit({
        type: 'llm.start',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: {},
      });

      expect(orchestrator.supervisor.get(handle.id)?.state).toBe('completed');
      unsub();
    });

    it('unsubscribe stops auto-state', () => {
      const handle = orchestrator.register(makeRegistration());
      orchestrator.supervisor.transition(handle.id, 'running');
      const unsub = orchestrator.enableAutoState();
      unsub();

      eventBus.emit({
        type: 'tool.call',
        requestId: handle.sessionId,
        timestamp: Date.now(),
        data: { toolName: 'bash' },
      });

      // Should still be running, not tool_calling
      expect(orchestrator.supervisor.get(handle.id)?.state).toBe('running');
    });
  });

  describe('policyTags', () => {
    it('send preserves policyTags on delivered message', () => {
      const handle1 = orchestrator.register(makeRegistration({ agentId: 'a' }));
      orchestrator.supervisor.transition(handle1.id, 'running');
      const handle2 = orchestrator.register(makeRegistration({ agentId: 'b' }));

      orchestrator.send(handle1.id, handle2.id, {
        type: 'notification',
        payload: { data: 'test' },
        policyTags: ['tainted', 'pii'],
      });

      const messages = orchestrator.pollMessages(handle2.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].policyTags).toEqual(['tainted', 'pii']);
    });

    it('send works without policyTags (backward compatible)', () => {
      const handle1 = orchestrator.register(makeRegistration({ agentId: 'a' }));
      orchestrator.supervisor.transition(handle1.id, 'running');
      const handle2 = orchestrator.register(makeRegistration({ agentId: 'b' }));

      orchestrator.send(handle1.id, handle2.id, {
        type: 'notification',
        payload: { data: 'test' },
      });

      const messages = orchestrator.pollMessages(handle2.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].policyTags).toBeUndefined();
    });

    it('broadcast preserves policyTags', () => {
      const handle1 = orchestrator.register(makeRegistration({ agentId: 'a' }));
      orchestrator.supervisor.transition(handle1.id, 'running');
      orchestrator.register(makeRegistration({ agentId: 'b' }));

      const msgs = orchestrator.broadcast(handle1.id, { type: 'session', sessionId: 'session-1' }, {
        type: 'notification',
        payload: {},
        policyTags: ['external_content'],
      });

      expect(msgs[0].policyTags).toEqual(['external_content']);
    });
  });

  describe('shutdown', () => {
    it('cancels all active agents', () => {
      const a = orchestrator.register(makeRegistration({ agentId: 'a' }));
      orchestrator.supervisor.transition(a.id, 'running');
      const b = orchestrator.register(makeRegistration({ agentId: 'b' }));

      orchestrator.shutdown();

      expect(orchestrator.supervisor.get(a.id)?.state).toBe('canceled');
      expect(orchestrator.supervisor.get(b.id)?.state).toBe('canceled');
    });

    it('clears mailboxes', () => {
      const sender = orchestrator.register(makeRegistration({ agentId: 'sender' }));
      orchestrator.supervisor.transition(sender.id, 'running');
      const recipient = orchestrator.register(makeRegistration({ agentId: 'recipient' }));

      orchestrator.send(sender.id, recipient.id, {
        type: 'notification',
        payload: { text: 'before shutdown' },
      });

      orchestrator.shutdown();

      // Messages should be gone (though agent is now canceled, poll still works structurally)
      expect(orchestrator.pollMessages(recipient.id)).toHaveLength(0);
    });
  });
});
