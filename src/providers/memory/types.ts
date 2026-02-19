// src/providers/memory/types.ts — Memory provider types
import type { TaintTag } from '../../types.js';

export interface MemoryEntry {
  id?: string;
  scope: string;
  content: string;
  tags?: string[];
  taint?: TaintTag;
  createdAt?: Date;
}

export interface MemoryQuery {
  scope: string;
  query?: string;
  limit?: number;
  tags?: string[];
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
}

export interface ProactiveHint {
  source: 'memory' | 'pattern' | 'trigger';
  kind: 'pending_task' | 'temporal_pattern' | 'follow_up' | 'anomaly' | 'custom';
  reason: string;
  suggestedPrompt: string;
  confidence: number;
  scope: string;
  memoryId?: string;
  cooldownMinutes?: number;
}

export interface MemoryProvider {
  write(entry: MemoryEntry): Promise<string>;
  query(q: MemoryQuery): Promise<MemoryEntry[]>;
  read(id: string): Promise<MemoryEntry | null>;
  delete(id: string): Promise<void>;
  list(scope: string, limit?: number): Promise<MemoryEntry[]>;
  memorize?(conversation: ConversationTurn[]): Promise<void>;
  onProactiveHint?(handler: (hint: ProactiveHint) => void): void;
}
