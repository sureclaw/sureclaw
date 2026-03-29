import { describe, it, expect } from 'vitest';
import { CommandsModule } from '../../../../src/agent/prompt/modules/commands.js';

describe('CommandsModule', () => {
  const mod = new CommandsModule();

  it('has correct name and priority', () => {
    expect(mod.name).toBe('commands');
    expect(mod.priority).toBe(72);
  });

  it('shouldInclude returns false when no commands', () => {
    const ctx = { commands: [] } as any;
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  it('shouldInclude returns false when commands undefined', () => {
    const ctx = {} as any;
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  it('shouldInclude returns true when commands exist', () => {
    const ctx = {
      commands: [{ name: 'forecast', pluginName: 'sales', content: '# /forecast\nGenerate forecast.' }],
    } as any;
    expect(mod.shouldInclude(ctx)).toBe(true);
  });

  it('renders command table', () => {
    const ctx = {
      commands: [
        { name: 'forecast', pluginName: 'sales', content: '# /forecast\nGenerate weighted sales forecast.' },
        { name: 'pipeline-review', pluginName: 'sales', content: '# /pipeline-review\nAnalyze pipeline health.' },
      ],
    } as any;
    const lines = mod.render(ctx);
    const text = lines.join('\n');
    expect(text).toContain('/forecast');
    expect(text).toContain('/pipeline-review');
    expect(text).toContain('sales');
    expect(text).toContain('Plugin Commands');
  });

  it('renders minimal version', () => {
    const ctx = {
      commands: [
        { name: 'forecast', pluginName: 'sales', content: '...' },
      ],
    } as any;
    const lines = mod.renderMinimal(ctx);
    expect(lines.join('\n')).toContain('1');
  });
});
