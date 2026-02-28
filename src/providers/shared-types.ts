/**
 * Cross-provider type re-exports.
 *
 * Types that multiple provider categories need to reference. Provider
 * implementations import from here instead of reaching into sibling
 * provider directories, which would create cross-category coupling that
 * blocks independent package extraction.
 *
 * Canonical definitions stay in their home provider's types.ts — this
 * file is purely a re-export hub.
 */

// ─── Channel primitives (used by scheduler, future: webhooks) ───
export type {
  SessionAddress,
  SessionScope,
  InboundMessage,
  Attachment,
} from './channel/types.js';

// ─── Memory types (used by scheduler for proactive hints) ───
export type {
  ProactiveHint,
  MemoryProvider,
} from './memory/types.js';

// ─── Audit types (used by scheduler for event logging) ───
export type {
  AuditProvider,
} from './audit/types.js';
