// src/host/server-request-handlers.ts — Shared HTTP request handlers for server.ts and host-process.ts.
//
// Extracts: handleModels, handleCompletions (body parsing + streaming + non-streaming),
// handleEventsSSE (EventBus-based SSE), and createSchedulerCallback factory.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import { isValidSessionId } from '../paths.js';
import { sendError, sendSSEChunk, sendSSENamedEvent, readBody } from './server-http.js';
import type { OpenAIChatRequest } from './server-http.js';
import { resolveDelivery } from './delivery.js';
import type { EventBus, StreamEvent } from './event-bus.js';
import type { Router } from './router.js';
import type { Config, ProviderRegistry, ContentBlock } from '../types.js';
import type { InboundMessage } from '../providers/channel/types.js';

const logger = getLogger();

/** SSE keepalive interval. */
const SSE_KEEPALIVE_MS = 15_000;

// ── Models ──

export function handleModels(res: ServerResponse, modelId: string): void {
  const body = JSON.stringify({
    object: 'list',
    data: [{ id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'ax' }],
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

// ── Completions ──

export interface CompletionHandlerOpts {
  modelId: string;
  agentName: string;
  agentDirVal: string;
  eventBus: EventBus;
  /** Called to run the completion. Allows callers to wrap with NATS logic. */
  runCompletion: (
    content: string | ContentBlock[],
    requestId: string,
    messages: { role: string; content: string | ContentBlock[] }[],
    sessionId: string,
    userId?: string,
  ) => Promise<{ responseContent: string; finishReason: 'stop' | 'content_filter'; contentBlocks?: ContentBlock[] }>;
  /** Optional pre-flight check (e.g. bootstrap gate). Return error string to reject, undefined to proceed. */
  preFlightCheck?: (sessionId: string, userId: string | undefined) => string | undefined;
}

/**
 * Parse the OpenAI chat request body and derive sessionId/userId.
 * Shared between server.ts and host-process.ts.
 */
export function parseChatRequest(
  chatReq: OpenAIChatRequest,
  modelId: string,
): { sessionId: string; userId: string | undefined; content: string | ContentBlock[]; requestModel: string } | { error: string } {
  if (!chatReq.messages?.length) {
    return { error: 'messages array is required' };
  }
  if (chatReq.session_id !== undefined && !isValidSessionId(chatReq.session_id)) {
    return { error: 'Invalid session_id' };
  }

  const requestModel = chatReq.model ?? modelId;

  let sessionId = chatReq.session_id;
  if (!sessionId && chatReq.user) {
    const parts = chatReq.user.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const agentPrefix = chatReq.model?.startsWith('agent:')
        ? chatReq.model.slice(6) : 'main';
      const candidate = `${agentPrefix}:http:${parts[0]}:${parts[1]}`;
      if (isValidSessionId(candidate)) sessionId = candidate;
    }
  }
  if (!sessionId) sessionId = randomUUID();

  const lastMsg = chatReq.messages[chatReq.messages.length - 1];
  const content = lastMsg?.content ?? '';
  const userId = chatReq.user?.split('/')[0] || undefined;

  return { sessionId, userId, content, requestModel };
}

export async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CompletionHandlerOpts,
): Promise<void> {
  const requestId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 413, 'Request body too large');
    return;
  }

  let chatReq: OpenAIChatRequest;
  try {
    chatReq = JSON.parse(body);
  } catch {
    sendError(res, 400, 'Invalid JSON');
    return;
  }

  const parsed = parseChatRequest(chatReq, opts.modelId);
  if ('error' in parsed) {
    sendError(res, 400, parsed.error);
    return;
  }
  const { sessionId, userId, content, requestModel } = parsed;

  // Optional pre-flight (bootstrap gate, etc.)
  if (opts.preFlightCheck) {
    const rejection = opts.preFlightCheck(sessionId, userId);
    if (rejection) {
      sendError(res, 403, rejection);
      return;
    }
  }

  logger.info('chat_request', {
    requestId, sessionId, stream: !!chatReq.stream,
    model: requestModel, userId: userId ?? 'anonymous',
    messageCount: chatReq.messages.length,
  });

  if (chatReq.stream) {
    // ── Streaming mode ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': requestId,
      'X-Accel-Buffering': 'no',
    });

    sendSSEChunk(res, {
      id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    let streamedContent = false;
    let toolCallIndex = 0;
    let hasToolCalls = false;

    const unsubscribe = opts.eventBus.subscribeRequest(requestId, (event: StreamEvent) => {
      try {
        if (event.type === 'llm.chunk' && typeof event.data.content === 'string') {
          streamedContent = true;
          sendSSEChunk(res, {
            id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
            choices: [{ index: 0, delta: { content: event.data.content as string }, finish_reason: null }],
          });
        } else if (event.type === 'tool.call' && event.data.toolName) {
          streamedContent = true;
          hasToolCalls = true;
          sendSSEChunk(res, {
            id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
            choices: [{ index: 0, delta: {
              tool_calls: [{
                index: toolCallIndex++,
                id: (event.data.toolId as string) ?? `call_${toolCallIndex}`,
                type: 'function',
                function: {
                  name: event.data.toolName as string,
                  arguments: JSON.stringify(event.data.args ?? {}),
                },
              }],
            }, finish_reason: null }],
          });
        } else if (event.type === 'oauth.required' && event.data.envName) {
          sendSSENamedEvent(res, 'oauth_required', {
            envName: event.data.envName as string,
            sessionId: event.data.sessionId as string,
            authorizeUrl: event.data.authorizeUrl as string,
            requestId,
          });
        } else if (event.type === 'credential.required' && event.data.envName) {
          sendSSENamedEvent(res, 'credential_required', {
            envName: event.data.envName as string,
            sessionId: event.data.sessionId as string,
            requestId,
          });
        }
      } catch { /* client gone, skip */ }
    });

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* client gone */ }
    }, SSE_KEEPALIVE_MS);

    const onClientGone = () => {
      clearInterval(keepalive);
      unsubscribe();
    };
    req.on('close', onClientGone);
    req.on('error', onClientGone);

    try {
      const result = await opts.runCompletion(content, requestId, chatReq.messages, sessionId, userId);

      if (!streamedContent && result.responseContent) {
        sendSSEChunk(res, {
          id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
          choices: [{ index: 0, delta: { content: result.responseContent }, finish_reason: null }],
        });
      }

      const streamFinishReason = hasToolCalls && result.finishReason === 'stop'
        ? 'tool_calls' as const : result.finishReason;
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: {}, finish_reason: streamFinishReason }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      logger.error('completion_failed', { requestId, error: (err as Error).message });
      if (!res.writableEnded) {
        sendSSEChunk(res, {
          id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
          choices: [{ index: 0, delta: { content: '\n\nInternal processing error' }, finish_reason: 'stop' }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } finally {
      clearInterval(keepalive);
      unsubscribe();
    }
  } else {
    // ── Non-streaming mode ──
    try {
      const result = await opts.runCompletion(content, requestId, chatReq.messages, sessionId, userId);

      const response = {
        id: requestId, object: 'chat.completion', created, model: requestModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.responseContent },
          finish_reason: result.finishReason,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };

      const responseBody = JSON.stringify(response);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(responseBody)) });
      res.end(responseBody);
    } catch (err) {
      logger.error('completion_failed', { requestId, error: (err as Error).message });
      sendError(res, 500, 'Internal server error');
    }
  }
}

// ── Events SSE (EventBus-based, used by server.ts) ──

export function handleEventsSSE(req: IncomingMessage, res: ServerResponse, eventBus: EventBus): void {
  const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
  const requestIdFilter = parsedUrl.searchParams.get('request_id') ?? undefined;
  const typesParam = parsedUrl.searchParams.get('types') ?? undefined;
  const typeFilter = typesParam ? new Set(typesParam.split(',').map(t => t.trim()).filter(Boolean)) : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');

  const listener = (event: StreamEvent) => {
    if (typeFilter && !typeFilter.has(event.type)) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* client disconnected */ }
  };

  const unsubscribe = requestIdFilter
    ? eventBus.subscribeRequest(requestIdFilter, listener)
    : eventBus.subscribe(listener);

  const keepalive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { /* client gone */ }
  }, SSE_KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ── Scheduler callback factory ──

export interface SchedulerCallbackOpts {
  config: Config;
  router: Router;
  sessionCanaries: Map<string, string>;
  sessionStore: ProviderRegistry['storage']['sessions'];
  agentName: string;
  channels: ProviderRegistry['channels'];
  scheduler: ProviderRegistry['scheduler'];
  runCompletion: (
    content: string,
    requestId: string,
    messages: { role: string; content: string }[],
    sessionId: string,
    userId?: string,
    preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
  ) => Promise<{ responseContent: string }>;
}

export function createSchedulerCallback(opts: SchedulerCallbackOpts): (msg: InboundMessage) => Promise<void> {
  const { config, router, sessionCanaries, sessionStore, agentName, channels, scheduler } = opts;

  return async (msg: InboundMessage) => {
    const result = await router.processInbound(msg);
    if (!result.queued) return;

    sessionCanaries.set(result.sessionId, result.canaryToken);
    const requestId = `sched-${randomUUID().slice(0, 8)}`;
    const { responseContent } = await opts.runCompletion(
      msg.content,
      requestId,
      [{ role: 'user', content: msg.content }],
      result.sessionId,
      undefined,
      { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
    );

    if (!responseContent.trim()) {
      logger.info('scheduler_message_processed', {
        sender: msg.sender, sessionId: result.sessionId,
        contentLength: responseContent.length, hasResponse: false,
      });
      return;
    }

    let delivery: import('../providers/scheduler/types.js').CronDelivery | undefined;
    let jobAgentId = agentName;

    if (msg.sender.startsWith('cron:')) {
      const jobId = msg.sender.slice(5);
      const jobs = await scheduler.listJobs?.() ?? [];
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        jobAgentId = job.agentId;
        delivery = job.delivery ?? config.scheduler.defaultDelivery;
      } else {
        delivery = config.scheduler.defaultDelivery;
      }
    } else {
      delivery = config.scheduler.defaultDelivery;
    }

    const resolution = await resolveDelivery(delivery, {
      sessionStore,
      agentId: jobAgentId,
      defaultDelivery: config.scheduler.defaultDelivery,
      channels,
    });

    if (resolution.mode === 'channel' && resolution.session && resolution.channelProvider) {
      const outbound = await router.processOutbound(responseContent, result.sessionId, result.canaryToken);
      if (!outbound.canaryLeaked) {
        try {
          await resolution.channelProvider.send(resolution.session, { content: outbound.content });
          logger.info('cron_delivered', {
            sender: msg.sender, provider: resolution.session.provider,
            contentLength: outbound.content.length,
          });
        } catch (err) {
          logger.error('cron_delivery_failed', {
            sender: msg.sender, provider: resolution.session.provider,
            error: (err as Error).message,
          });
        }
      } else {
        logger.warn('cron_delivery_canary_leaked', { sender: msg.sender });
      }
    }

    logger.info('scheduler_message_processed', {
      sender: msg.sender, sessionId: result.sessionId,
      contentLength: responseContent.length, hasResponse: true,
    });
  };
}
