// src/host/sandbox-tools/router.ts — Intent router for sandbox tool calls
//
// Classifies tool calls as Tier 1 (WASM) or Tier 2 (container/local) using
// deterministic pattern matching. Routes conservatively: always Tier 2 when
// uncertain.
//
// Every routing decision is logged with a reason string for audit trail
// and to build a dataset for expanding Tier 1 coverage over time.

import { getLogger } from '../../logger.js';
import { classifyBashCommand } from './bash-classifier.js';
import type { SandboxToolRequest, ToolRoute } from './types.js';

const logger = getLogger().child({ component: 'sandbox-router' });

export interface RouterConfig {
  /** Master kill switch: when false, everything goes to Tier 2. */
  wasmEnabled: boolean;
  /** Whether to emit shadow metrics for "would-have-been-tier-1" decisions. */
  shadowMode: boolean;
  /**
   * Compare mode: run both Tier 1 and Tier 2 for Tier 1 candidates,
   * serve Tier 2 results but log mismatches. Used for canary validation.
   * Only active when wasmEnabled=true and shadowMode=false.
   */
  compareMode?: boolean;
}

/**
 * Route a sandbox tool call to the appropriate execution tier.
 *
 * Rules:
 * - If WASM is disabled, route everything to Tier 2
 * - If a WASM module exists for the tool AND the specific operation is supported, route to Tier 1
 * - If the tool call includes unsupported flags, pipes, shell metacharacters, route to Tier 2
 * - Always route to Tier 2 when uncertain
 */
export function routeToolCall(
  request: SandboxToolRequest,
  config: RouterConfig,
): ToolRoute {
  // Kill switch — everything to Tier 2
  if (!config.wasmEnabled) {
    const route: ToolRoute = {
      tier: 2,
      executor: 'default',
      reason: 'wasm disabled by config',
    };
    logger.debug('route_decision', { tool: request.type, ...route });
    return route;
  }

  let route: ToolRoute;

  switch (request.type) {
    case 'read_file':
      route = {
        tier: 1,
        executor: 'wasm',
        reason: 'read_file: structured file operation with WASM module',
      };
      break;

    case 'write_file':
      route = {
        tier: 1,
        executor: 'wasm',
        reason: 'write_file: structured file operation with WASM module',
      };
      break;

    case 'edit_file':
      route = {
        tier: 1,
        executor: 'wasm',
        reason: 'edit_file: structured file operation with WASM module',
      };
      break;

    case 'bash': {
      const classification = classifyBashCommand(request.command);
      if (classification.tier1) {
        route = {
          tier: 1,
          executor: 'wasm',
          reason: classification.reason,
        };
      } else {
        route = {
          tier: 2,
          executor: 'default',
          reason: classification.reason,
        };
      }
      break;
    }
  }

  // In shadow mode, log what would have been Tier 1 but still route to Tier 2
  if (config.shadowMode && route.tier === 1) {
    logger.info('shadow_tier1_candidate', {
      tool: request.type,
      reason: route.reason,
      command: request.type === 'bash' ? (request as any).command?.slice(0, 200) : undefined,
    });
    route = {
      tier: 2,
      executor: 'default',
      reason: `shadow mode: would have been tier 1 (${route.reason})`,
    };
  }

  logger.debug('route_decision', { tool: request.type, ...route });
  return route;
}
