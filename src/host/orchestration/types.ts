/**
 * Agent Orchestration — shared types.
 *
 * Defines the vocabulary for agent lifecycle management, inter-agent
 * messaging, and runtime discovery. Everything here is host-side only;
 * agents interact through IPC schemas defined in ipc-schemas.ts.
 */

import type { AgentType } from '../../types.js';

// ═══════════════════════════════════════════════════════
// Agent Lifecycle States
// ═══════════════════════════════════════════════════════

/**
 * Agent lifecycle states (inspired by A2A task lifecycle).
 *
 * Transition diagram:
 *   spawning → running → [thinking | tool_calling | waiting_for_llm | delegating] → completed
 *                      ↘ interrupted → canceled
 *                      ↘ failed
 *                      ↘ canceled
 *
 * Terminal states: completed, failed, canceled.
 */
export type AgentState =
  | 'spawning'
  | 'running'
  | 'thinking'
  | 'tool_calling'
  | 'waiting_for_llm'
  | 'delegating'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'canceled';

export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set([
  'completed', 'failed', 'canceled',
]);

export const ACTIVE_STATES: ReadonlySet<AgentState> = new Set([
  'spawning', 'running', 'thinking', 'tool_calling',
  'waiting_for_llm', 'delegating', 'interrupted',
]);

/**
 * Valid state transitions. Key = current state, value = set of allowed next states.
 * Enforced by AgentSupervisor.transition().
 */
export const STATE_TRANSITIONS: Record<AgentState, ReadonlySet<AgentState>> = {
  spawning: new Set(['running', 'failed', 'canceled']),
  running: new Set(['thinking', 'tool_calling', 'waiting_for_llm', 'delegating', 'interrupted', 'completed', 'failed', 'canceled']),
  thinking: new Set(['running', 'tool_calling', 'waiting_for_llm', 'interrupted', 'completed', 'failed', 'canceled']),
  tool_calling: new Set(['running', 'thinking', 'waiting_for_llm', 'interrupted', 'completed', 'failed', 'canceled']),
  waiting_for_llm: new Set(['running', 'thinking', 'tool_calling', 'interrupted', 'completed', 'failed', 'canceled']),
  delegating: new Set(['running', 'thinking', 'tool_calling', 'waiting_for_llm', 'interrupted', 'completed', 'failed', 'canceled']),
  interrupted: new Set(['canceled', 'completed', 'failed']),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
};

// ═══════════════════════════════════════════════════════
// Agent Handle — runtime identity of a running agent
// ═══════════════════════════════════════════════════════

export interface AgentHandle {
  /** Unique runtime ID for this execution (not the registry agent ID). */
  readonly id: string;
  /** Registry agent ID (e.g. 'main', 'researcher'). */
  readonly agentId: string;
  /** Agent type (pi-coding-agent, claude-code). */
  readonly agentType: AgentType;
  /** Current lifecycle state. */
  state: AgentState;
  /** Parent handle ID (null for top-level agents). */
  readonly parentId: string | null;
  /** Session this agent is serving. */
  readonly sessionId: string;
  /** User who initiated this agent. */
  readonly userId: string;
  /** When this agent was spawned (ms). */
  readonly startedAt: number;
  /** When the state last changed (ms). */
  lastStateChange: number;
  /** Human-readable description of current activity. */
  activity: string;
  /** Metadata: model, tools available, etc. */
  metadata: Record<string, unknown>;
}

export interface AgentRegistration {
  agentId: string;
  agentType: AgentType;
  parentId?: string | null;
  sessionId: string;
  userId: string;
  activity?: string;
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════
// Agent Messages
// ═══════════════════════════════════════════════════════

export type AgentMessageType = 'request' | 'response' | 'notification' | 'interrupt';

export interface AgentMessage {
  /** Unique message ID. */
  readonly id: string;
  /** Sender agent handle ID. */
  readonly from: string;
  /** Recipient agent handle ID. */
  readonly to: string;
  /** Message type. */
  readonly type: AgentMessageType;
  /** Message payload (validated by IPC schema, max size enforced). */
  readonly payload: Record<string, unknown>;
  /** Timestamp (ms). */
  readonly timestamp: number;
  /** Correlation ID for request/response pairs. */
  readonly correlationId?: string;
  /** Policy/taint tags for taint tracking across agent boundaries. */
  readonly policyTags?: readonly string[];
}

// ═══════════════════════════════════════════════════════
// Message Scoping
// ═══════════════════════════════════════════════════════

export type MessageScope =
  | { type: 'session'; sessionId: string }
  | { type: 'user'; userId: string }
  | { type: 'children'; parentId: string }
  | { type: 'all' };

// ═══════════════════════════════════════════════════════
// Query Types
// ═══════════════════════════════════════════════════════

export interface AgentQuery {
  sessionId?: string;
  userId?: string;
  parentId?: string;
  agentId?: string;
  state?: AgentState | AgentState[];
  agentType?: AgentType;
}

export interface AgentTree {
  handle: AgentHandle;
  children: AgentTree[];
}

// ═══════════════════════════════════════════════════════
// Snapshot (serializable view for API responses)
// ═══════════════════════════════════════════════════════

export interface AgentSnapshot {
  id: string;
  agentId: string;
  agentType: AgentType;
  state: AgentState;
  parentId: string | null;
  sessionId: string;
  userId: string;
  startedAt: number;
  lastStateChange: number;
  activity: string;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export function toSnapshot(handle: AgentHandle): AgentSnapshot {
  return {
    id: handle.id,
    agentId: handle.agentId,
    agentType: handle.agentType,
    state: handle.state,
    parentId: handle.parentId,
    sessionId: handle.sessionId,
    userId: handle.userId,
    startedAt: handle.startedAt,
    lastStateChange: handle.lastStateChange,
    activity: handle.activity,
    durationMs: Date.now() - handle.startedAt,
    metadata: handle.metadata,
  };
}


