// src/agent/prompt/tool-index-loader.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'tool-index-loader' });

export interface ToolIndexSkill {
  name: string;
  tools: Array<{ name: string; description?: string }>;
}

export interface ToolIndex {
  /** Compact multi-line string for the prompt. Empty string if no tools. */
  render: string;
  /** Structured form for programmatic access. */
  skills: ToolIndexSkill[];
}

const EMPTY: ToolIndex = { render: '', skills: [] };

interface RawToolEntry {
  name?: unknown;
  description?: unknown;
  parameters?: {
    properties?: Record<string, unknown>;
    required?: unknown[];
  };
}

/**
 * Maximum enum values rendered inline per parameter. Past this, we truncate
 * with `|…` so a 50-value enum can't blow up the prompt. Six covers every
 * real-world case we've seen (Linear cycles: 3, issue states: ~5) without
 * reserving pathological budget for outliers.
 */
const ENUM_RENDER_CAP = 6;

/**
 * Format a JSON-schema property into a suffix for the compact function
 * signature. Enum values get surfaced as a union literal (`"a"|"b"|"c"`) —
 * this is the only reliable place to put them before the agent has already
 * written a script. Without this, a prompt line like `listCycles(teamId, type?)`
 * gives the model zero signal about valid values, and it will freely
 * hallucinate adjacent ones (`'active'`, `'open'`). Falls back to no suffix
 * when the enum is empty, malformed, or non-string.
 */
function renderParamSuffix(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return '';
  const values = (prop as { enum?: unknown[] }).enum;
  if (!Array.isArray(values) || values.length === 0) return '';
  const strings = values.filter((v): v is string => typeof v === 'string');
  if (strings.length === 0 || strings.length !== values.length) return '';
  const shown = strings.slice(0, ENUM_RENDER_CAP).map(v => JSON.stringify(v)).join('|');
  const suffix = strings.length > ENUM_RENDER_CAP ? `${shown}|…` : shown;
  return `: ${suffix}`;
}

interface RawIndex {
  skill?: unknown;
  tools?: unknown;
}

/**
 * Scan `<workspacePath>/.ax/tools/<skill>/_index.json` files written by
 * `syncToolModulesForSkill` and aggregate them into a single compact render
 * string for the system prompt plus a structured form for programmatic use.
 *
 * Fail-open: a missing workspace or missing `.ax/tools` dir yields an empty
 * index. A malformed or incomplete `_index.json` is logged and skipped — a
 * partial skill install must not block prompt generation for the whole agent.
 */
export function loadToolIndex(workspacePath: string): ToolIndex {
  const toolsDir = join(workspacePath, '.ax', 'tools');

  let entries: string[];
  try {
    entries = readdirSync(toolsDir);
  } catch {
    return EMPTY;
  }

  const skills: ToolIndexSkill[] = [];
  const renderLines: string[] = [];

  for (const name of entries.sort()) {
    const skillDir = join(toolsDir, name);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const indexPath = join(skillDir, '_index.json');
    let content: string;
    try {
      content = readFileSync(indexPath, 'utf8');
    } catch {
      // No _index.json in this subdir — not a tool skill entry.
      continue;
    }

    let raw: RawIndex;
    try {
      raw = JSON.parse(content) as RawIndex;
    } catch (err) {
      logger.warn('tool_index_malformed_json', { skill: name, error: String(err) });
      continue;
    }

    if (!Array.isArray(raw.tools)) {
      logger.warn('tool_index_missing_tools', { skill: name });
      continue;
    }

    const rawTools = raw.tools as RawToolEntry[];
    if (rawTools.length === 0) {
      continue;
    }

    const fnSignatures: string[] = [];
    const structuredTools: Array<{ name: string; description?: string }> = [];

    for (const tool of rawTools) {
      if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
      const props = tool.parameters?.properties ?? {};
      const required = new Set(
        Array.isArray(tool.parameters?.required)
          ? (tool.parameters!.required as unknown[]).filter((r): r is string => typeof r === 'string')
          : [],
      );
      const paramKeys = Object.keys(props);
      const params = paramKeys
        .map(p => {
          const base = required.has(p) ? p : `${p}?`;
          return `${base}${renderParamSuffix(props[p])}`;
        })
        .join(', ');
      // Wrap in destructuring braces so the agent sees a single-object-arg
      // call shape, not a positional one. Bare `listCycles(teamId, type?)`
      // reads as TypeScript positional (`fn(a, b)`) and the agent calls
      // `listCycles(team.id, 'current')`, which the runtime guard then
      // correctly rejects as non-object. Zero-arity stays bare (`ping()`)
      // to avoid misleading empty braces.
      const signature = paramKeys.length === 0
        ? `${snakeToCamel(tool.name)}()`
        : `${snakeToCamel(tool.name)}({ ${params} })`;
      fnSignatures.push(signature);

      const structured: { name: string; description?: string } = { name: tool.name };
      if (typeof tool.description === 'string') structured.description = tool.description;
      structuredTools.push(structured);
    }

    if (fnSignatures.length === 0) continue;

    skills.push({ name, tools: structuredTools });
    renderLines.push(`  ${name}: ${fnSignatures.join(', ')}`);
  }

  return { render: renderLines.join('\n'), skills };
}

/**
 * Convert snake_case to camelCase: list_issues → listIssues.
 * Duplicated from `src/host/toolgen/codegen.ts` to keep the agent-side
 * loader free of host-layer imports.
 */
function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
