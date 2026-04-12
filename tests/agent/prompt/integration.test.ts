// tests/agent/prompt/integration.test.ts
import { describe, test, expect } from 'vitest';
import { PromptBuilder } from '../../../src/agent/prompt/builder.js';
import type { PromptContext, SkillSummary } from '../../../src/agent/prompt/types.js';

function makeSkill(name: string, description: string): SkillSummary {
  return { name, description, path: `${name.toLowerCase().replace(/\s+/g, '-')}.md` };
}

describe('PromptBuilder integration', () => {
  test('full prompt with all sections', () => {
    const ctx: PromptContext = {
      agentType: 'pi-coding-agent',
      workspace: '/home/user/project',
      skills: [
        makeSkill('Safety Skill', 'Always follow safety rules'),
        makeSkill('Memory Skill', 'You can remember things'),
      ],
      profile: 'paranoid',
      sandboxType: 'docker',
      taintRatio: 0.15,
      taintThreshold: 0.10,
      identityFiles: {
        agents: 'You are Manon, a TypeScript developer for the AX project.',
        soul: 'I am methodical, security-conscious, and thorough. I explain before acting.',
        identity: 'Name: Manon\nRole: TypeScript developer\nProject: AX',
        user: 'The user prefers concise responses and TDD workflow.',
        bootstrap: '',
        userBootstrap: '',
        heartbeat: '',
      },
      contextWindow: 200000,
      historyTokens: 5000,
    };

    const result = new PromptBuilder().build(ctx);

    // Verify structure order: identity < injection < security < tool-style < memory-recall < skills < delegation < runtime
    const content = result.content;
    const positions = {
      identity: content.indexOf('Manon'),
      injection: content.indexOf('Injection Defense'),
      security: content.indexOf('Security Boundaries'),
      toolStyle: content.indexOf('## Tool Usage'),
      memoryRecall: content.indexOf('## Memory'),
      skills: content.indexOf('Safety Skill'),
      delegation: content.indexOf('## Task Delegation'),
      runtime: content.indexOf('## Runtime'),
    };

    expect(positions.identity).toBeLessThan(positions.injection);
    expect(positions.injection).toBeLessThan(positions.security);
    expect(positions.security).toBeLessThan(positions.toolStyle);
    expect(positions.toolStyle).toBeLessThan(positions.memoryRecall);
    expect(positions.memoryRecall).toBeLessThan(positions.skills);
    expect(positions.skills).toBeLessThan(positions.delegation);
    expect(positions.delegation).toBeLessThan(positions.runtime);

    // Verify taint awareness (elevated because 15% > 10% threshold)
    expect(content).toContain('ELEVATED');
    expect(content).toContain('15.0%');

    // Verify metadata — 8 modules now (identity, injection, security, tool-style, memory-recall, skills, delegation, runtime)
    expect(result.metadata.moduleCount).toBe(8);
    expect(result.metadata.estimatedTokens).toBeGreaterThan(100);
    expect(result.metadata.buildTimeMs).toBeLessThan(100);

    // Verify per-module token breakdown (Task 16 observability)
    expect(result.metadata.tokensByModule).toBeDefined();
    expect(Object.keys(result.metadata.tokensByModule).length).toBe(8);
    expect(result.metadata.tokensByModule['identity']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['injection-defense']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['security']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['tool-style']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['memory-recall']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['skills']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['delegation']).toBeGreaterThan(0);
    expect(result.metadata.tokensByModule['runtime']).toBeGreaterThan(0);
  });

  test('budget-constrained prompt drops optional modules', () => {
    const ctx: PromptContext = {
      agentType: 'pi-coding-agent',
      workspace: '/tmp',
      skills: [makeSkill('Big Skill', 'A very large skill')],
      profile: 'paranoid',
      sandboxType: 'docker',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agents: 'Bot.', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },
      contextWindow: 2000, // Very tight
      historyTokens: 500,
      // Available: 2000 - 500 - 4096 = negative! Required modules only.
    };

    const result = new PromptBuilder().build(ctx);

    // Required modules (identity, injection-defense, security) should be present
    expect(result.metadata.modules).toContain('identity');
    expect(result.metadata.modules).toContain('injection-defense');
    expect(result.metadata.modules).toContain('security');

    // Optional modules (runtime) should be dropped due to negative budget
    expect(result.metadata.modules).not.toContain('runtime');
  });
});
