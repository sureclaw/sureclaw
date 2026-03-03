// tests/providers/memory/memoryfs/prompts.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildSummaryPrompt,
  buildSummaryPromptWithRefs,
  buildPatchPrompt,
  parsePatchResponse,
  stripCodeFences,
} from '../../../../src/providers/memory/memoryfs/prompts.js';

describe('buildSummaryPrompt', () => {
  it('includes category name and target length', () => {
    const prompt = buildSummaryPrompt({
      category: 'preferences',
      originalContent: '',
      newItems: ['Prefers TypeScript', 'Uses vim'],
      targetLength: 400,
    });
    expect(prompt).toContain('preferences');
    expect(prompt).toContain('400');
    expect(prompt).toContain('Prefers TypeScript');
    expect(prompt).toContain('Uses vim');
  });

  it('instructs LLM not to wrap in code fences', () => {
    const prompt = buildSummaryPrompt({
      category: 'preferences',
      originalContent: '',
      newItems: ['test'],
      targetLength: 400,
    });
    expect(prompt).toContain('Do NOT wrap in code fences');
  });

  it('includes original content when provided', () => {
    const prompt = buildSummaryPrompt({
      category: 'preferences',
      originalContent: '# preferences\n## Editor\n- Uses emacs\n',
      newItems: ['Uses vim now'],
      targetLength: 400,
    });
    expect(prompt).toContain('Uses emacs');
    expect(prompt).toContain('Uses vim now');
  });
});

describe('buildSummaryPromptWithRefs', () => {
  it('includes item IDs for ref citations', () => {
    const prompt = buildSummaryPromptWithRefs({
      category: 'preferences',
      originalContent: '',
      newItemsWithIds: [
        { refId: 'a1b2c3', content: 'Prefers TypeScript' },
        { refId: 'd4e5f6', content: 'Uses vim' },
      ],
      targetLength: 400,
    });
    expect(prompt).toContain('[a1b2c3]');
    expect(prompt).toContain('[d4e5f6]');
    expect(prompt).toContain('[ref:');
  });
});

describe('buildPatchPrompt', () => {
  it('formats add operation', () => {
    const prompt = buildPatchPrompt({
      category: 'preferences',
      originalContent: '# preferences\n## Editor\n- Uses vim\n',
      updateContent: 'This memory content is newly added:\nPrefers dark mode',
    });
    expect(prompt).toContain('preferences');
    expect(prompt).toContain('Uses vim');
    expect(prompt).toContain('newly added');
  });
});

describe('parsePatchResponse', () => {
  it('parses need_update true response', () => {
    const result = parsePatchResponse('{"need_update": true, "updated_content": "# preferences\\n## Editor\\n- Uses vim\\n- Prefers dark mode\\n"}');
    expect(result.needUpdate).toBe(true);
    expect(result.updatedContent).toContain('dark mode');
  });

  it('parses need_update false response', () => {
    const result = parsePatchResponse('{"need_update": false, "updated_content": ""}');
    expect(result.needUpdate).toBe(false);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parsePatchResponse('not json');
    expect(result.needUpdate).toBe(false);
  });
});

describe('stripCodeFences', () => {
  it('strips ```markdown fences', () => {
    const input = '```markdown\n# preferences\n## Editor\n- Uses vim\n```';
    expect(stripCodeFences(input)).toBe('# preferences\n## Editor\n- Uses vim');
  });

  it('strips ```md fences', () => {
    const input = '```md\n# habits\n- Runs tests\n```';
    expect(stripCodeFences(input)).toBe('# habits\n- Runs tests');
  });

  it('strips bare ``` fences', () => {
    const input = '```\n# knowledge\n- Uses TypeScript\n```';
    expect(stripCodeFences(input)).toBe('# knowledge\n- Uses TypeScript');
  });

  it('leaves clean markdown unchanged', () => {
    const input = '# preferences\n## Editor\n- Uses vim';
    expect(stripCodeFences(input)).toBe(input);
  });

  it('handles case-insensitive fence markers', () => {
    const input = '```Markdown\n# test\n```';
    expect(stripCodeFences(input)).toBe('# test');
  });
});
