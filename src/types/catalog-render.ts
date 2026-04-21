/**
 * Shared catalog render helper for the tool-dispatch-unification work.
 *
 * Lives in `src/types/` so both host and agent can import it. The function
 * is pure and stateless — it takes a list of catalog tools and emits the
 * "## Available tools" block used in the agent system prompt.
 *
 * Host-side callers previously called `renderCatalogOneLiners(catalog: ToolCatalog)`;
 * that signature is preserved in `src/host/tool-catalog/render.ts` as a
 * backward-compat shim that forwards to this array-taking implementation.
 */
import type { CatalogTool } from './catalog.js';

export function renderCatalogOneLinersFromArray(tools: CatalogTool[]): string {
  if (tools.length === 0) return '';

  const bySkill = new Map<string, CatalogTool[]>();
  for (const t of tools) {
    const arr = bySkill.get(t.skill) ?? [];
    arr.push(t);
    bySkill.set(t.skill, arr);
  }

  const lines: string[] = ['## Available tools', ''];
  for (const [skill, group] of bySkill) {
    lines.push(`### ${skill}`);
    for (const t of group) {
      const props = (t.schema.properties as Record<string, unknown>) ?? {};
      const required = new Set(Array.isArray(t.schema.required) ? t.schema.required as string[] : []);
      // `_select` is a reserved jq projection knob — see `call-tool.ts` /
      // `jq.ts` for the host-side implementation. It's always optional and
      // never part of the server's real schema, so we append it here rather
      // than treat it as a tool-author property.
      const params = Object.keys(props)
        .map(p => required.has(p) ? p : `${p}?`)
        .concat('_select?')
        .join(', ');
      lines.push(`- ${t.name}(${params}) \u2014 ${t.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
