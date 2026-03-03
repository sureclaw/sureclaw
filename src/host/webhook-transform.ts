/**
 * LLM-powered webhook payload transform.
 *
 * Takes a markdown transform file (system prompt) and raw webhook
 * payload (user content), calls a fast LLM, and returns structured
 * output describing what the agent should do — or null to skip.
 */

import { z } from 'zod';
import type { LLMProvider } from '../providers/llm/types.js';
import type { WebhookTransformResult, TransformFn } from './server-webhooks.js';

const TransformResultSchema = z.strictObject({
  message: z.string().min(1),
  agentId: z.string().optional(),
  sessionKey: z.string().optional(),
  model: z.string().optional(),
  timeoutSec: z.number().int().positive().optional(),
});

const SYSTEM_PREAMBLE = `You are a webhook payload transformer. You receive a webhook payload and HTTP headers. Your job is to extract the relevant information and return a JSON object that will be used to trigger an AI agent.

Your response MUST be valid JSON — either:
1. An object with at least a "message" field (string): the prompt for the agent.
   Optional fields: "agentId" (string), "sessionKey" (string), "model" (string), "timeoutSec" (number).
2. The literal value null — meaning this event should be ignored.

No markdown fencing. No explanation. Just the JSON value.

The following document describes how to handle payloads for this webhook source:

`;

export function createWebhookTransform(
  llm: LLMProvider,
  defaultModel: string,
): TransformFn {
  return async function transform(
    transformContent: string,
    headers: Record<string, string>,
    payload: unknown,
    modelOverride?: string,
  ): Promise<WebhookTransformResult | null> {
    const model = modelOverride ?? defaultModel;
    const systemPrompt = SYSTEM_PREAMBLE + transformContent;
    const userContent = JSON.stringify({ headers, payload }, null, 2);

    let responseText = '';
    for await (const chunk of llm.chat({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      maxTokens: 1024,
      taskType: 'fast',
    })) {
      if (chunk.type === 'text' && chunk.content) {
        responseText += chunk.content;
      }
    }

    const trimmed = responseText.trim();

    // Handle null (skip event)
    if (trimmed === 'null') return null;

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Webhook transform returned invalid JSON: ${trimmed.slice(0, 200)}`);
    }

    if (parsed === null) return null;

    // Validate schema
    const validated = TransformResultSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw new Error(`Webhook transform returned invalid structure: ${issues}`);
    }

    return validated.data;
  };
}
