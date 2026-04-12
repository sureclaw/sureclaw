/**
 * Orchestrator — central coordinator for multi-agent systems.
 *
 * The Orchestrator ties together the EventBus, AgentSupervisor, and
 * AgentDirectory into a single facade. It adds:
 *
 * 1. Agent-to-agent messaging (routed through the trusted host)
 * 2. Scoped broadcasting
 * 3. Query API for active agents
 * 4. Auto-state-inference from EventBus events (llm.start → waiting_for_llm, etc.)
 *
 * All messages flow through the host — no sandbox-to-sandbox leaks.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus, EventListener, StreamEvent } from '../event-bus.js';
import type { AuditProvider } from '../../providers/audit/types.js';
import { getLogger } from '../../logger.js';
import { createAgentSupervisor, type AgentSupervisor, type AgentSupervisorConfig } from './agent-supervisor.js';
import { createAgentDirectory, type AgentDirectory } from './agent-directory.js';
import type {
  AgentHandle,
  AgentMessage,
  AgentQuery,
  AgentRegistration,
  AgentSnapshot,
  AgentTree,
  MessageScope,
} from './types.js';
import { TERMINAL_STATES, toSnapshot } from './types.js';

const logger = getLogger().child({ component: 'orchestrator' });

/** Maximum pending messages per agent before oldest gets dropped. */
const MAX_MAILBOX_SIZE = 100;

/** Maximum message payload size in bytes (serialized). */
const MAX_MESSAGE_PAYLOAD_BYTES = 50_000;

export interface Orchestrator {
  /** The underlying event bus. */
  readonly eventBus: EventBus;

  /** The agent supervisor. */
  readonly supervisor: AgentSupervisor;

  /** The agent directory. */
  readonly directory: AgentDirectory;

  /** Register a new agent (convenience wrapper around supervisor.register). */
  register(opts: AgentRegistration): AgentHandle;

  /** Send a direct message from one agent to another. */
  send(from: string, to: string, message: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>): AgentMessage;

  /** Broadcast a message to all agents matching a scope. */
  broadcast(from: string, scope: MessageScope, message: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>): AgentMessage[];

  /** Subscribe to messages for a specific agent handle. Returns unsubscribe fn. */
  onMessage(handleId: string, listener: (msg: AgentMessage) => void): () => void;

  /** Poll and drain the mailbox for an agent. Returns pending messages. */
  pollMessages(handleId: string, limit?: number): AgentMessage[];

  /** Query active agents with filters. Returns snapshots (serializable). */
  query(filter: AgentQuery): AgentSnapshot[];

  /** Get the full agent tree for a root agent. */
  tree(rootId: string): AgentTree | null;

  /**
   * Enable auto-state inference from EventBus events.
   * Maps existing events (llm.start, tool.call, etc.) to supervisor state transitions.
   */
  enableAutoState(): () => void;

  /** Shut down: clear all handles, listeners, mailboxes. */
  shutdown(): void;
}

export interface OrchestratorConfig {
  supervisor?: AgentSupervisorConfig;
  maxMailboxSize?: number;
  maxMessagePayloadBytes?: number;
}

export function createOrchestrator(
  eventBus: EventBus,
  audit?: AuditProvider,
  config?: OrchestratorConfig,
): Orchestrator {
  const supervisor = createAgentSupervisor(eventBus, audit, config?.supervisor);
  const directory = createAgentDirectory(supervisor);

  /** Per-agent mailboxes: handleId → queued messages. */
  const mailboxes = new Map<string, AgentMessage[]>();

  /** Per-agent message listeners: handleId → listener set. */
  const messageListeners = new Map<string, Set<(msg: AgentMessage) => void>>();

  const maxMailbox = config?.maxMailboxSize ?? MAX_MAILBOX_SIZE;
  const maxPayloadBytes = config?.maxMessagePayloadBytes ?? MAX_MESSAGE_PAYLOAD_BYTES;

  /** Map from requestId/sessionId → set of handleIds, for auto-state inference. */
  const sessionToHandles = new Map<string, Set<string>>();

  function register(opts: AgentRegistration): AgentHandle {
    const handle = supervisor.register(opts);
    // Track session→handle mapping for auto-state (supports multiple agents per session)
    let handles = sessionToHandles.get(handle.sessionId);
    if (!handles) {
      handles = new Set();
      sessionToHandles.set(handle.sessionId, handles);
    }
    handles.add(handle.id);
    return handle;
  }

  function validatePayload(payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    if (serialized.length > maxPayloadBytes) {
      throw new Error(`Message payload exceeds max size (${serialized.length} > ${maxPayloadBytes} bytes)`);
    }
  }

  function deliverMessage(msg: AgentMessage): void {
    // Emit event for observability
    eventBus.emit({
      type: 'agent.message',
      requestId: msg.to, // Use recipient for request-scoped subscription
      timestamp: msg.timestamp,
      data: {
        messageId: msg.id,
        from: msg.from,
        to: msg.to,
        messageType: msg.type,
        correlationId: msg.correlationId,
        payloadKeys: Object.keys(msg.payload),
      },
    });

    // Push to mailbox for pull-based consumption
    let mailbox = mailboxes.get(msg.to);
    if (!mailbox) {
      mailbox = [];
      mailboxes.set(msg.to, mailbox);
    }
    if (mailbox.length >= maxMailbox) {
      const dropped = mailbox.shift();
      logger.warn('mailbox_overflow', {
        handleId: msg.to,
        droppedMessageId: dropped?.id,
        maxSize: maxMailbox,
      });
    }
    mailbox.push(msg);

    // Notify push-based listeners
    const listeners = messageListeners.get(msg.to);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(msg);
        } catch (err) {
          logger.warn('message_listener_error', {
            handleId: msg.to,
            error: (err as Error).message,
          });
        }
      }
    }
  }

  function send(
    from: string,
    to: string,
    partial: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>,
  ): AgentMessage {
    // Validate sender exists and is active
    const sender = supervisor.get(from);
    if (!sender) {
      throw new Error(`Sender agent ${from} not found`);
    }
    if (TERMINAL_STATES.has(sender.state)) {
      throw new Error(`Sender agent ${from} is in terminal state: ${sender.state}`);
    }

    // Validate recipient exists
    const recipient = supervisor.get(to);
    if (!recipient) {
      throw new Error(`Recipient agent ${to} not found`);
    }

    validatePayload(partial.payload);

    const msg: AgentMessage = {
      id: randomUUID(),
      from,
      to,
      type: partial.type,
      payload: partial.payload,
      timestamp: Date.now(),
      correlationId: partial.correlationId,
      policyTags: partial.policyTags,
    };

    deliverMessage(msg);

    logger.debug('agent_message_sent', {
      messageId: msg.id,
      from: msg.from,
      to: msg.to,
      type: msg.type,
    });

    return msg;
  }

  function broadcast(
    from: string,
    scope: MessageScope,
    partial: Omit<AgentMessage, 'id' | 'from' | 'to' | 'timestamp'>,
  ): AgentMessage[] {
    const sender = supervisor.get(from);
    if (!sender) {
      throw new Error(`Sender agent ${from} not found`);
    }

    validatePayload(partial.payload);

    // Find all recipients matching scope (excluding sender, excluding terminal agents)
    let recipients: AgentHandle[];
    switch (scope.type) {
      case 'session':
        recipients = directory.bySession(scope.sessionId);
        break;
      case 'user':
        recipients = directory.byUser(scope.userId);
        break;
      case 'children':
        recipients = directory.byParent(scope.parentId);
        break;
      case 'all':
        recipients = supervisor.all();
        break;
    }

    // Exclude sender and terminal agents
    recipients = recipients.filter(
      r => r.id !== from && !TERMINAL_STATES.has(r.state)
    );

    const messages: AgentMessage[] = [];
    for (const recipient of recipients) {
      const msg: AgentMessage = {
        id: randomUUID(),
        from,
        to: recipient.id,
        type: partial.type,
        payload: partial.payload,
        timestamp: Date.now(),
        correlationId: partial.correlationId,
        policyTags: partial.policyTags,
      };
      deliverMessage(msg);
      messages.push(msg);
    }

    logger.debug('agent_broadcast', {
      from,
      scope,
      recipientCount: messages.length,
      type: partial.type,
    });

    return messages;
  }

  function onMessage(handleId: string, listener: (msg: AgentMessage) => void): () => void {
    let listeners = messageListeners.get(handleId);
    if (!listeners) {
      listeners = new Set();
      messageListeners.set(handleId, listeners);
    }
    listeners.add(listener);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const set = messageListeners.get(handleId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) messageListeners.delete(handleId);
      }
    };
  }

  function pollMessages(handleId: string, limit: number = 50): AgentMessage[] {
    const mailbox = mailboxes.get(handleId);
    if (!mailbox || mailbox.length === 0) return [];

    const messages = mailbox.splice(0, limit);
    if (mailbox.length === 0) mailboxes.delete(handleId);

    return messages;
  }

  function query(filter: AgentQuery): AgentSnapshot[] {
    return directory.list(filter).map(toSnapshot);
  }

  function tree(rootId: string): AgentTree | null {
    return directory.tree(rootId);
  }

  /**
   * Auto-state inference: listen to existing EventBus events and
   * map them to supervisor state transitions automatically.
   *
   * This bridges the gap between the existing event emissions in
   * ipc-handlers/llm.ts (llm.start, tool.call, llm.done) and the
   * new agent state model without requiring changes to those handlers.
   */
  function enableAutoState(): () => void {
    const listener: EventListener = (event: StreamEvent) => {
      // Find all handles for this event's requestId (sessionId)
      const handleIds = sessionToHandles.get(event.requestId);
      if (!handleIds) return;

      // Apply state transition to all active (non-terminal) handles in this session.
      // Skip no-op transitions (e.g. tool_calling → tool_calling when multiple
      // tool calls fire in the same LLM turn) to avoid noisy warnings.
      for (const handleId of handleIds) {
        const handle = supervisor.get(handleId);
        if (!handle || TERMINAL_STATES.has(handle.state)) continue;

        try {
          switch (event.type) {
            case 'llm.start':
              if (handle.state !== 'waiting_for_llm') {
                supervisor.transition(handleId, 'waiting_for_llm', `LLM call: ${event.data.model ?? 'default'}`);
              }
              break;
            case 'llm.thinking':
              if (handle.state !== 'thinking') {
                supervisor.transition(handleId, 'thinking', 'Extended thinking');
              }
              break;
            case 'llm.done':
              if (handle.state !== 'running') {
                supervisor.transition(handleId, 'running', 'Processing LLM response');
              }
              break;
            case 'tool.call':
              if (handle.state !== 'tool_calling') {
                supervisor.transition(handleId, 'tool_calling', `Tool: ${event.data.toolName ?? 'unknown'}`);
              } else {
                // Already tool_calling — update activity label without a state transition.
                handle.activity = `Tool: ${event.data.toolName ?? 'unknown'}`;
              }
              break;
            case 'completion.agent':
              if (handle.state === 'spawning') {
                supervisor.transition(handleId, 'running', 'Agent started');
              }
              break;
          }
        } catch {
          // Invalid transition — ignore. The auto-state is best-effort.
        }
      }
    };

    return eventBus.subscribe(listener);
  }

  function shutdown(): void {
    // Cancel all active agents
    for (const handle of supervisor.all()) {
      if (!TERMINAL_STATES.has(handle.state)) {
        supervisor.cancel(handle.id, 'Orchestrator shutdown');
      }
    }

    // Clear all mailboxes and listeners
    mailboxes.clear();
    messageListeners.clear();
    sessionToHandles.clear();

    logger.info('orchestrator_shutdown');
  }

  return {
    eventBus,
    supervisor,
    directory,
    register,
    send,
    broadcast,
    onMessage,
    pollMessages,
    query,
    tree,
    enableAutoState,
    shutdown,
  };
}
