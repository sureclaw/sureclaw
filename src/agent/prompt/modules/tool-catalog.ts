// src/agent/prompt/modules/tool-catalog.ts
import { BasePromptModule } from '../base-module.js';
import type { PromptContext } from '../types.js';
import { renderCatalogOneLinersFromArray } from '../../../types/catalog-render.js';

/**
 * Tool catalog module: renders the host-delivered catalog as a
 * "## Available tools" block grouped by skill.
 *
 * Priority 92 — after RuntimeModule (90), before ReplyGateModule (95). Sits
 * near the end of the prompt so agents see a unified "here are your tools"
 * view right before the reply gate.
 *
 * Optional — drops under budget pressure. Renders nothing when the catalog
 * is absent or empty.
 */
export class ToolCatalogModule extends BasePromptModule {
  readonly name = 'tool-catalog';
  readonly priority = 92;
  readonly optional = true;

  shouldInclude(ctx: PromptContext): boolean {
    return !!ctx.catalog && ctx.catalog.length > 0;
  }

  render(ctx: PromptContext): string[] {
    const tools = ctx.catalog ?? [];
    if (tools.length === 0) return [];
    const rendered = renderCatalogOneLinersFromArray(tools);
    if (!rendered) return [];
    // Append a compact usage note after the listing. The two meta-tools
    // (`describe_tools` + `call_tool`) are the only dispatch surface — the
    // LLM looks up a schema first, then invokes. MCP servers pick their own
    // flag/response conventions (`teamId` vs `team_id`, `{team:{id}}` vs
    // `{id}`), so the schema lookup is not optional.
    const lines = rendered.split('\n');
    lines.push('');
    lines.push('### Calling catalog tools');
    lines.push('');
    lines.push('Dispatch goes through **two meta-tools**:');
    lines.push('- `describe_tools(names: ["mcp_..."])` — returns the full JSON schema. Pass `[]` to list every tool.');
    lines.push('- `call_tool(tool: "mcp_...", args: {...})` — invokes. Pass `args._select` as a jq string to project the response server-side (keeps your context small).');
    lines.push('');
    lines.push('Flag names and response shapes are NOT what you would guess from the tool name — they differ per MCP server. **Always** call `describe_tools` for any unfamiliar tool BEFORE its first `call_tool`. Do not copy arg shapes between different tools in the same skill; call_tool args match the specific tool\'s schema, not a convention. If a response field you expect is `null` or missing, use `describe_tools` again to confirm the real shape — do not substitute the user\'s query string as a UUID or invent a fallback.');
    lines.push('');
    lines.push('### When an expected tool is missing');
    lines.push('');
    lines.push('If the user asks about functionality you believe should exist (e.g. "list pets" for a petstore skill) and the catalog does NOT contain a matching tool, **report the gap explicitly** — do not paper over it. Concretely:');
    lines.push('- FIRST call `describe_tools([])` once to confirm the current catalog directory. The listing above is authoritative for this turn.');
    lines.push('- If the tool truly is not there: tell the user, plainly, which skill you expected it under and what you could not find. Example: "The `petstore` skill is installed but I don\'t see any `api_petstore_*` tools in this turn\'s catalog — the skill may have failed to load. Ask the operator to check catalog population logs."');
    lines.push('- **Do NOT** invent tool names by guessing prefixes (`mcp_` vs `api_`) or operationIds. If a tool isn\'t in the catalog listing above, it cannot be called.');
    lines.push('- **Do NOT** fabricate a replacement skill via `skill_write` as a workaround. Skill creation is for legitimately new integrations requested by the user — never as a fallback for a tool you couldn\'t find. URLs, MCP servers, and API endpoints must come from the user, the skill-creator flow, or verified documentation — never invented.');
    lines.push('- A missing tool is a SURFACING opportunity, not a puzzle to solve silently. The operator would much rather hear "I can\'t find the tool I expected" than have you guess.');
    return lines;
  }
}

/** Factory for consumers that prefer a function-style constructor. */
export function makeToolCatalogModule(): ToolCatalogModule {
  return new ToolCatalogModule();
}
