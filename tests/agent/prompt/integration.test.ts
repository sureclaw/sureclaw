// tests/agent/prompt/integration.test.ts
import { describe, test, expect } from 'vitest';
import { PromptBuilder } from '../../../src/agent/prompt/builder.js';
import type { PromptContext } from '../../../src/agent/prompt/types.js';

describe('PromptBuilder integration', () => {
  test('full prompt with all sections', () => {
    const ctx: PromptContext = {
      agentType: 'pi-agent-core',
      workspace: '/home/user/project',
      skills: [
        '# Safety Skill\n\nAlways follow safety rules.\n\n## Rules\n1. No harmful actions\n2. Ask before destructive ops',
        '# Memory Skill\n\nYou can remember things.\n\n## Usage\nUse memory_write to save.',
      ],
      profile: 'paranoid',
      sandboxType: 'nsjail',
      taintRatio: 0.15,
      taintThreshold: 0.10,
      identityFiles: {
        agents: 'You are Manon, a TypeScript developer for the AX project.',
        soul: 'I am methodical, security-conscious, and thorough. I explain before acting.',
        identity: 'Name: Manon\nRole: TypeScript developer\nProject: AX',
        user: 'The user prefers concise responses and TDD workflow.',
        bootstrap: '',
        userBootstrap: '',
      },
      contextContent: '# AX Project\n\nA security-first AI agent framework.\n\n## Stack\nTypeScript, Node.js, Vitest',
      contextWindow: 200000,
      historyTokens: 5000,
    };

    const result = new PromptBuilder().build(ctx);

    // Verify structure order: identity < injection < security < context < skills < runtime
    const content = result.content;
    const positions = {
      identity: content.indexOf('Manon'),
      injection: content.indexOf('Injection Defense'),
      security: content.indexOf('Security Boundaries'),
      context: content.indexOf('AX Project'),
      skills: content.indexOf('Safety Skill'),
      runtime: content.indexOf('## Runtime'),
    };

    expect(positions.identity).toBeLessThan(positions.injection);
    expect(positions.injection).toBeLessThan(positions.security);
    expect(positions.security).toBeLessThan(positions.context);
    expect(positions.context).toBeLessThan(positions.skills);
    expect(positions.skills).toBeLessThan(positions.runtime);

    // Verify taint awareness (elevated because 15% > 10% threshold)
    expect(content).toContain('ELEVATED');
    expect(content).toContain('15.0%');

    // Verify metadata
    expect(result.metadata.moduleCount).toBe(6); // all 6 modules
    expect(result.metadata.estimatedTokens).toBeGreaterThan(100);
    expect(result.metadata.buildTimeMs).toBeLessThan(100);

    // Verify per-module token breakdown (Task 16 observability)
    expect(result.metadata.tokensByModule).toBeDefined();
    expect(Object.keys(result.metadata.tokensByModule).length).toBe(6);
    expect(result.metadata.tokensByModule['identity']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['injection-defense']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['security']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['context']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['skills']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['runtime']).toBeGreaterThan(0);
  });

  test('budget-constrained prompt drops optional modules', () => {
    const ctx: PromptContext = {
      agentType: 'pi-agent-core',
      workspace: '/tmp',
      skills: ['# Skill\n' + 'x'.repeat(4000)], // ~1000 tokens
      profile: 'paranoid',
      sandboxType: 'subprocess',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agents: 'Bot.', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '' },
      contextContent: 'x'.repeat(4000), // ~1000 tokens
      contextWindow: 2000, // Very tight
      historyTokens: 500,
      // Available: 2000 - 500 - 4096 = negative! Required modules only.
    };

    const result = new PromptBuilder().build(ctx);

    // Required modules (identity, injection-defense, security) should be present
    expect(result.metadata.modules).toContain('identity');
    expect(result.metadata.modules).toContain('injection-defense');
    expect(result.metadata.modules).toContain('security');

    // Optional modules (context, runtime) should be dropped due to negative budget
    expect(result.metadata.modules).not.toContain('context');
    expect(result.metadata.modules).not.toContain('runtime');
  });
});
