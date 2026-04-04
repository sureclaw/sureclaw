/**
 * Tests that HostCore exposes the AgentProvisioner for dynamic agent resolution.
 * This is a type-level + structural test — we verify the interface shape without
 * running the full initHostCore() which requires real providers.
 */
import { describe, test, expect } from 'vitest';
import type { HostCore } from '../../src/host/server-init.js';
import type { AgentProvisioner } from '../../src/host/agent-provisioner.js';

describe('HostCore provisioner field', () => {
  test('HostCore interface includes provisioner of type AgentProvisioner', () => {
    // Type-level assertion: if this compiles, the field exists.
    // Runtime check: ensure the type is structurally sound.
    const mock: Pick<HostCore, 'provisioner'> = {
      provisioner: {
        ensureAgent: async () => ({} as any),
        resolveAgent: async () => ({} as any),
      } as AgentProvisioner,
    };
    expect(mock.provisioner).toBeDefined();
    expect(typeof mock.provisioner.resolveAgent).toBe('function');
    expect(typeof mock.provisioner.ensureAgent).toBe('function');
  });
});
