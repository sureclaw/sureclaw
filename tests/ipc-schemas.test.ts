import { describe, test, expect } from 'vitest';
import {
  IPC_SCHEMAS, IPCEnvelopeSchema,
  LlmCallSchema, MemoryWriteSchema, MemoryReadSchema,
  SkillReadSchema, AuditQuerySchema, WebFetchSchema,
} from '../src/ipc-schemas.js';

describe('IPC Schema Validation (SC-SEC-001)', () => {

  // ── Envelope ──
  describe('Envelope', () => {
    test('accepts known action', () => {
      expect(IPCEnvelopeSchema.safeParse({ action: 'llm_call' }).success).toBe(true);
    });

    test('rejects unknown action', () => {
      expect(IPCEnvelopeSchema.safeParse({ action: 'evil_action' }).success).toBe(false);
    });

    test('rejects missing action', () => {
      expect(IPCEnvelopeSchema.safeParse({}).success).toBe(false);
    });

    test('rejects non-object', () => {
      expect(IPCEnvelopeSchema.safeParse('string').success).toBe(false);
      expect(IPCEnvelopeSchema.safeParse(42).success).toBe(false);
      expect(IPCEnvelopeSchema.safeParse(null).success).toBe(false);
    });
  });

  // ── LLM Call ──
  describe('LlmCallSchema', () => {
    const valid = {
      action: 'llm_call' as const,
      messages: [{ role: 'user' as const, content: 'hello' }],
    };

    test('accepts valid request', () => {
      expect(LlmCallSchema.safeParse(valid).success).toBe(true);
    });

    test('accepts with optional fields', () => {
      expect(LlmCallSchema.safeParse({
        ...valid,
        model: 'claude-sonnet-4-20250514',
        temperature: 0.7,
        maxTokens: 1000,
      }).success).toBe(true);
    });

    test('rejects extra fields (strict mode)', () => {
      expect(LlmCallSchema.safeParse({ ...valid, evil: 'field' }).success).toBe(false);
    });

    test('rejects empty messages', () => {
      expect(LlmCallSchema.safeParse({ ...valid, messages: [] }).success).toBe(false);
    });

    test('rejects null bytes in content', () => {
      const withNull = { ...valid, messages: [{ role: 'user', content: 'hello\0world' }] };
      expect(LlmCallSchema.safeParse(withNull).success).toBe(false);
    });

    test('rejects invalid role', () => {
      const badRole = { ...valid, messages: [{ role: 'admin', content: 'hello' }] };
      expect(LlmCallSchema.safeParse(badRole).success).toBe(false);
    });
  });

  // ── Memory Write ──
  describe('MemoryWriteSchema', () => {
    const valid = {
      action: 'memory_write' as const,
      scope: 'user_alice',
      content: 'Alice prefers dark mode',
    };

    test('accepts valid request', () => {
      expect(MemoryWriteSchema.safeParse(valid).success).toBe(true);
    });

    test('rejects scope with path traversal', () => {
      expect(MemoryWriteSchema.safeParse({ ...valid, scope: '../etc' }).success).toBe(false);
    });

    test('rejects scope starting with non-alphanumeric', () => {
      expect(MemoryWriteSchema.safeParse({ ...valid, scope: '_admin' }).success).toBe(false);
    });

    test('rejects extra fields', () => {
      expect(MemoryWriteSchema.safeParse({ ...valid, drop_tables: true }).success).toBe(false);
    });
  });

  // ── Memory Read ──
  describe('MemoryReadSchema', () => {
    test('accepts valid UUID', () => {
      expect(MemoryReadSchema.safeParse({
        action: 'memory_read',
        id: '550e8400-e29b-41d4-a716-446655440000',
      }).success).toBe(true);
    });

    test('rejects non-UUID', () => {
      expect(MemoryReadSchema.safeParse({
        action: 'memory_read',
        id: 'not-a-uuid',
      }).success).toBe(false);
    });
  });

  // ── Web Fetch ──
  describe('WebFetchSchema', () => {
    test('accepts valid URL', () => {
      expect(WebFetchSchema.safeParse({
        action: 'web_fetch',
        url: 'https://example.com',
      }).success).toBe(true);
    });

    test('rejects non-URL', () => {
      expect(WebFetchSchema.safeParse({
        action: 'web_fetch',
        url: 'not a url',
      }).success).toBe(false);
    });
  });

  // ── Skill Read ──
  describe('SkillReadSchema', () => {
    test('accepts valid name', () => {
      expect(SkillReadSchema.safeParse({
        action: 'skill_read',
        name: 'default',
      }).success).toBe(true);
    });

    test('rejects null bytes in name', () => {
      expect(SkillReadSchema.safeParse({
        action: 'skill_read',
        name: 'test\0evil',
      }).success).toBe(false);
    });
  });

  // ── Audit Query ──
  describe('AuditQuerySchema', () => {
    test('accepts empty filter', () => {
      expect(AuditQuerySchema.safeParse({ action: 'audit_query' }).success).toBe(true);
    });

    test('accepts with filter', () => {
      expect(AuditQuerySchema.safeParse({
        action: 'audit_query',
        filter: { action: 'llm_call', limit: 10 },
      }).success).toBe(true);
    });
  });

  // ── Prototype pollution prevention ──
  describe('Prototype pollution prevention', () => {
    test('rejects __proto__ on LLM call', () => {
      const payload = {
        action: 'llm_call',
        messages: [{ role: 'user', content: 'hi' }],
        '__proto__': { admin: true },
      };
      expect(LlmCallSchema.safeParse(payload).success).toBe(false);
    });

    test('rejects constructor on Memory write', () => {
      const payload = {
        action: 'memory_write',
        scope: 'test',
        content: 'x',
        constructor: { prototype: { admin: true } },
      };
      expect(MemoryWriteSchema.safeParse(payload).success).toBe(false);
    });
  });

  // ── Schema completeness ──
  describe('Schema completeness', () => {
    test('every action in IPC_SCHEMAS has a schema', () => {
      for (const action of Object.keys(IPC_SCHEMAS)) {
        expect(IPC_SCHEMAS[action]).toBeDefined();
      }
    });

    test('all schemas reject payloads with only extra keys', () => {
      for (const [action, schema] of Object.entries(IPC_SCHEMAS)) {
        const withExtra = { action, extraEvil: 'payload' };
        const result = schema.safeParse(withExtra);
        // Should fail due to strict mode or missing required fields
        expect(result.success).toBe(false);
      }
    });
  });
});
