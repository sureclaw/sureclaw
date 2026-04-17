import { parse as parseYaml } from 'yaml';
import { SkillFrontmatterSchema, type SkillFrontmatter } from './frontmatter-schema.js';

export type ParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; error: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillFile(content: string): ParseResult {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { ok: false, error: 'missing or unterminated YAML frontmatter' };
  }
  const [, yamlText, body] = match;

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `invalid YAML: ${msg}` };
  }

  const parsed = SkillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, frontmatter: parsed.data, body };
}
