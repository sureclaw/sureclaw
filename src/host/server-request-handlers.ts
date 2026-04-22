// src/host/server-request-handlers.ts — Shared HTTP request handlers for server.ts and host-process.ts.
//
// Extracts: handleModels, handleCompletions (body parsing + streaming + non-streaming),
// handleEventsSSE (EventBus-based SSE), createSchedulerCallback factory,
// and createRequestHandler() — the unified HTTP route dispatch factory.

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
import { canonicalize, type InboundMessage } from '../providers/channel/types.js';
import type { AuthProvider, AuthResult } from '../providers/auth/types.js';
import { handleFileUpload, handleFileDownload } from './server-files.js';
import type { FileStore } from '../file-store.js';
import type { GcsFileStorage } from './gcs-file-storage.js';
import type { TaintBudget } from './taint-budget.js';
import { createChatApiHandler } from './server-chat-api.js';
import { createChatUIHandler } from './server-chat-ui.js';

const logger = getLogger();

/** SSE keepalive interval. */
const SSE_KEEPALIVE_MS = 15_000;

// Hard-coded HTML responses for OAuth callback outcomes. Each branch renders
// a string literal so there's no variable interpolation — semgrep's
// raw-html-format rule was flagging the dynamic template even though we
// escaped the reason, and `adminResult.reason` is a closed 3-literal union
// anyway. Using a lookup table also gives us room to write friendlier,
// more helpful user-facing text than the raw enum identifier.
const OAUTH_CALLBACK_HTML = {
  success: '<html><body><h2>Authentication successful</h2><p>You can close this tab and return to the dashboard.</p></body></html>',
  token_exchange_failed: '<html><body><h2>Authentication failed</h2><p>The authorization server rejected our exchange request. Try again, or check with your admin if this keeps happening.</p></body></html>',
  invalid_response: '<html><body><h2>Authentication failed</h2><p>The authorization response didn\'t look right — something got mangled between the provider and us. Please start over.</p></body></html>',
  error: '<html><body><h2>Authentication failed</h2><p>We hit an unexpected error finishing the OAuth flow. Check the server logs for details, or try again in a moment.</p></body></html>',
} as const;

// ── Auth middleware ──

export async function authenticateRequest(
  req: IncomingMessage,
  providers: AuthProvider[],
): Promise<AuthResult> {
  for (const provider of providers) {
    const result = await provider.authenticate(req);
    if (result !== null) return result;
  }
  return { authenticated: false };
}

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
  adminCtx: import('./server-admin-helpers.js').AdminContext;
  eventBus: EventBus;
  /** Called to run the completion. Allows callers to wrap with custom dispatch logic. */
  runCompletion: (
    content: string | ContentBlock[],
    requestId: string,
    messages: { role: string; content: string | ContentBlock[] }[],
    sessionId: string,
    userId?: string,
  ) => Promise<{
    responseContent: string;
    finishReason: 'stop' | 'content_filter';
    contentBlocks?: ContentBlock[];
    /** Per-turn diagnostics collected during `processCompletion` (Task B2 of
     *  the surface-skill-failures pipeline). Forwarded to the client as
     *  `event: diagnostic` SSE frames in streaming mode, or attached as a
     *  top-level `diagnostics` field on the JSON body in non-streaming mode.
     *  Absent array (legacy callers) behaves identically to an empty array —
     *  a clean turn emits zero diagnostic frames. */
    diagnostics?: readonly import('./diagnostics.js').Diagnostic[];
  }>;
  /** Optional pre-flight check (e.g. bootstrap gate). Return error string or undefined to proceed. */
  preFlightCheck?: (sessionId: string, userId: string | undefined) => string | undefined | Promise<string | undefined>;
}

/**
 * Parse the OpenAI chat request body and derive sessionId/userId.
 * Shared between server.ts and host-process.ts.
 */
export function parseChatRequest(
  chatReq: OpenAIChatRequest,
  modelId: string,
  agentId?: string,
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
      // Use placeholder '_' for workspace — processCompletion rewrites it
      // after the provisioner resolves the actual agent ID.
      const candidate = canonicalize({
        provider: 'http',
        scope: 'dm',
        identifiers: { workspace: '_', peer: parts[0], channel: parts[1] },
      });
      if (isValidSessionId(candidate)) sessionId = candidate;
    }
  }
  if (!sessionId) sessionId = randomUUID();

  const lastMsg = chatReq.messages[chatReq.messages.length - 1];
  const content = lastMsg?.content ?? '';
  const userId = chatReq.user?.split('/')[0] || 'guest';

  return { sessionId, userId, content, requestModel };
}

export async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CompletionHandlerOpts,
  authenticatedUserId?: string,
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

  const parsed = parseChatRequest(chatReq, opts.modelId, opts.agentName);
  if ('error' in parsed) {
    sendError(res, 400, parsed.error);
    return;
  }
  // When authenticated, bind userId to the verified principal — don't trust the request body
  const userId = authenticatedUserId ?? parsed.userId;
  const { sessionId, content, requestModel } = parsed;

  // Optional pre-flight (bootstrap gate, etc.)
  if (opts.preFlightCheck) {
    const rejection = await opts.preFlightCheck(sessionId, userId);
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
        } else if (
          event.type === 'status' &&
          typeof event.data.operation === 'string' &&
          typeof event.data.phase === 'string' &&
          typeof event.data.message === 'string'
        ) {
          sendSSENamedEvent(res, 'status', {
            operation: event.data.operation,
            phase: event.data.phase,
            message: event.data.message,
          });
        } else if (event.type === 'status') {
          logger.warn('status_event_invalid_payload', { requestId, data: event.data });
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

      // Send image/file content blocks as named SSE events before [DONE]
      if (result.contentBlocks) {
        for (const block of result.contentBlocks) {
          if (block.type === 'image' || block.type === 'file') {
            try { sendSSENamedEvent(res, 'content_block', block); } catch { /* client gone */ }
          }
        }
      }

      const streamFinishReason = hasToolCalls && result.finishReason === 'stop'
        ? 'tool_calls' as const : result.finishReason;
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: {}, finish_reason: streamFinishReason }],
      });

      // Emit turn-level diagnostics AFTER the finish-reason chunk and BEFORE
      // [DONE]. Order matters: SSE clients (including the chat UI's
      // `ax-chat-transport.ts`) treat everything before the finish-reason
      // chunk as streaming content, so diagnostics must land in the
      // post-finish window. An empty `diagnostics` array (clean turn or
      // legacy path) produces zero frames — the UI banner never fires on
      // happy paths. Typed as `Record<string, unknown>` for the helper;
      // the chat transport parses it as `Diagnostic` from the shared type.
      if (result.diagnostics && result.diagnostics.length > 0) {
        for (const diagnostic of result.diagnostics) {
          try {
            sendSSENamedEvent(res, 'diagnostic', diagnostic as unknown as Record<string, unknown>);
          } catch { /* client gone, skip */ }
        }
      }

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

      // Always emit `diagnostics` as an array — the chat UI is the
      // primary non-streaming consumer and uniformity beats wire-shape
      // bit-compat with pre-B2. Two shapes (`undefined` vs `[]`) forces
      // every consumer to remember an undefined-guard; one shape is a
      // guaranteed array. Legacy callers that don't populate the field
      // see `diagnostics: []` which is a no-op for their render logic.
      // Snapshot-test churn for external REST callers is a one-time
      // mechanical cost paid once; a silent undefined-access bug in
      // the UI on a clean turn is a recurring reliability cost.
      const response = {
        id: requestId, object: 'chat.completion', created, model: requestModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.responseContent },
          finish_reason: result.finishReason,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        diagnostics: result.diagnostics ?? [],
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
  isBootstrapMode?: () => boolean | Promise<boolean>;
  runCompletion: (
    content: string,
    requestId: string,
    messages: { role: string; content: string }[],
    sessionId: string,
    userId?: string,
    preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
    agentId?: string,
  ) => Promise<{ responseContent: string }>;
}

export function createSchedulerCallback(opts: SchedulerCallbackOpts): (msg: InboundMessage) => Promise<void> {
  const { config, router, sessionCanaries, sessionStore, agentName, channels, scheduler } = opts;

  return async (msg: InboundMessage) => {
    // Skip scheduler sessions when agent hasn't completed bootstrap —
    // an unbootstrapped agent can't handle tasks, and scheduler sessions
    // use a system userId that fails the admin gate for identity writes.
    // Intentionally dropped (not deferred): cron will fire again on its
    // next interval once bootstrap completes, and heartbeat ticks carry
    // no unique payload worth replaying.
    if (await opts.isBootstrapMode?.()) {
      logger.info('scheduler_skip_bootstrap', { sender: msg.sender });
      return;
    }

    const result = await router.processInbound(msg);
    if (!result.queued) return;

    sessionCanaries.set(result.sessionId, result.canaryToken);
    const requestId = `sched-${randomUUID().slice(0, 8)}`;

    // Resolve job metadata (agentId, delivery) before running completion
    // so the agent spawns with the correct identity and workspace.
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

    const { responseContent } = await opts.runCompletion(
      msg.content,
      requestId,
      [{ role: 'user', content: msg.content }],
      result.sessionId,
      undefined,
      { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
      jobAgentId,
    );

    if (!responseContent.trim()) {
      logger.info('scheduler_message_processed', {
        sender: msg.sender, sessionId: result.sessionId,
        contentLength: responseContent.length, hasResponse: false,
      });
      return;
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

// ── Shared request handler factory ──

export type WebhookHandler = (req: IncomingMessage, res: ServerResponse, webhookName: string) => Promise<void>;
export type AdminHandler = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>;

export interface RequestHandlerOpts {
  // Core dependencies
  modelId: string;
  agentName: string;
  adminCtx: import('./server-admin-helpers.js').AdminContext;
  eventBus: EventBus;
  providers: ProviderRegistry;
  fileStore: FileStore;
  gcsFileStorage?: GcsFileStorage;
  taintBudget: TaintBudget;

  // Completion
  completionOpts: CompletionHandlerOpts;

  // Webhook
  webhookPrefix: string;
  webhookHandler: WebhookHandler | null;

  // Admin
  adminHandler: AdminHandler | null;

  // Admin-initiated OAuth flow (phase 6) — used by /v1/oauth/callback/* to
  // resolve admin-provenance states before falling through to the
  // agent-initiated path (oauth-skills.ts).
  adminOAuthFlow?: import('./admin-oauth-flow.js').AdminOAuthFlow;
  /** Tuple-keyed skill credential store. Required whenever `adminOAuthFlow`
   *  is wired — tokens from OAuth callbacks land here. */
  skillCredStore?: import('./skills/skill-cred-store.js').SkillCredStore;
  /** Paired with adminOAuthFlow — the OAuth callback invalidates the
   *  agent's snapshot cache after tokens land so the next turn reads
   *  fresh skill state. */
  snapshotCache?: import('./skills/snapshot-cache.js').SnapshotCache<
    import('./skills/types.js').SkillSnapshotEntry[]
  >;

  // Drain state — caller manages the boolean; handler reads it
  isDraining: () => boolean;

  // Inflight tracking — caller provides start/end hooks for graceful drain
  trackRequestStart?: () => void;
  trackRequestEnd?: () => void;

  // Mode-specific routes — called BEFORE the 404 fallback.
  // Return true if the route was handled, false to fall through.
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>;

  /** Auth providers — checked in order for admin/chat routes. */
  authProviders?: AuthProvider[];
}

export function createRequestHandler(opts: RequestHandlerOpts): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const {
    modelId, eventBus, providers, fileStore, gcsFileStorage,
    completionOpts, webhookPrefix, webhookHandler, adminHandler,
    adminOAuthFlow, skillCredStore, snapshotCache,
    isDraining, trackRequestStart, trackRequestEnd, extraRoutes,
    authProviders,
  } = opts;

  // Create chat API handler if storage is available
  const chatApiHandler = providers.storage
    ? createChatApiHandler(providers.storage)
    : null;

  // Create chat UI handler for static file serving
  let chatUIHandler: ReturnType<typeof createChatUIHandler> | null = null;
  try {
    chatUIHandler = createChatUIHandler();
  } catch {
    // Chat UI not built — that's fine, skip
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    // Reject new requests during shutdown
    if (isDraining() && (url === '/v1/chat/completions' || url.startsWith(webhookPrefix))) {
      sendError(res, 503, 'Server is shutting down — not accepting new requests');
      return;
    }

    // Health
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: isDraining() ? 'draining' : 'ok' }));
      return;
    }

    // Models
    if (url === '/v1/models' && req.method === 'GET') {
      handleModels(res, modelId);
      return;
    }

    // Completions
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      let authenticatedUserId: string | undefined;
      if (authProviders?.length) {
        const authResult = await authenticateRequest(req, authProviders);
        if (!authResult.authenticated || !authResult.user) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        authenticatedUserId = authResult.user.id;
      }
      trackRequestStart?.();
      try {
        await handleCompletions(req, res, completionOpts, authenticatedUserId);
      } catch (err) {
        logger.error('request_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      } finally {
        trackRequestEnd?.();
      }
      return;
    }

    // File upload
    if (url.startsWith('/v1/files') && req.method === 'POST') {
      try {
        await handleFileUpload(req, res, { fileStore, gcsFileStorage });
      } catch (err) {
        logger.error('file_upload_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'File upload failed');
      }
      return;
    }

    // File download
    if (url.startsWith('/v1/files/') && req.method === 'GET') {
      try {
        await handleFileDownload(req, res, { fileStore, gcsFileStorage });
      } catch (err) {
        logger.error('file_download_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'File download failed');
      }
      return;
    }

    // SSE events
    if (url.startsWith('/v1/events') && req.method === 'GET') {
      handleEventsSSE(req, res, eventBus);
      return;
    }

    // Webhooks — supports both /webhooks/{name} and /webhooks/{agentId}/{name}
    if (webhookHandler && url.startsWith(webhookPrefix)) {
      const remainder = url.slice(webhookPrefix.length).split('?')[0];
      if (!remainder) {
        sendError(res, 404, 'Not found');
        return;
      }
      // Parse: "agentId/name" or just "name"
      const segments = remainder.split('/').filter(Boolean);
      let webhookName: string;
      let webhookAgentId: string | undefined;
      if (segments.length >= 2) {
        webhookAgentId = segments[0];
        webhookName = segments.slice(1).join('/');
      } else {
        webhookName = segments[0];
      }
      if (!webhookName) {
        sendError(res, 404, 'Not found');
        return;
      }
      // Inject agentId into the request headers so the webhook handler can use it
      if (webhookAgentId) {
        req.headers['x-ax-agent-id'] = webhookAgentId;
      }
      trackRequestStart?.();
      try {
        await webhookHandler(req, res, webhookName);
      } catch (err) {
        logger.error('webhook_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Webhook processing failed');
      } finally {
        trackRequestEnd?.();
      }
      return;
    }

    // OAuth callback — admin-initiated flow tries first (claims the state on
    // match, success or failure), then falls through to the agent-initiated
    // path in oauth-skills.ts when no admin flow is pending for this state.
    if (url.startsWith('/v1/oauth/callback/') && req.method === 'GET') {
      const provider = url.split('/v1/oauth/callback/')[1]?.split('?')[0];
      const params = new URL(req.url!, `http://${req.headers.host}`).searchParams;
      const code = params.get('code');
      const state = params.get('state');

      if (!provider || !code || !state) {
        const html = '<html><body><h2>Bad request</h2><p>Missing required parameters (code, state).</p></body></html>';
        res.writeHead(400, { 'Content-Type': 'text/html', 'Content-Length': String(Buffer.byteLength(html)) });
        res.end(html);
        return;
      }

      try {
        // Try admin-initiated flow first. If matched (regardless of ok),
        // we do NOT fall through — matched:true means the state was
        // consumed, and leaking it back to the agent module would defeat
        // the single-use replay defense.
        if (adminOAuthFlow && skillCredStore) {
          const adminResult = await adminOAuthFlow.resolveCallback({
            provider,
            code,
            state,
            skillCredStore,
            snapshotCache,
            audit: providers.audit,
          });
          if (adminResult.matched) {
            // Static-string lookup — no variable interpolation. TypeScript
            // guarantees the `reason` key resolves because the union is
            // closed over exactly the three OAUTH_CALLBACK_HTML keys.
            const html = adminResult.ok
              ? OAUTH_CALLBACK_HTML.success
              : OAUTH_CALLBACK_HTML[adminResult.reason];
            const status = adminResult.ok ? 200 : 400;
            res.writeHead(status, {
              'Content-Type': 'text/html',
              'Content-Length': String(Buffer.byteLength(html)),
            });
            res.end(html);
            return;
          }
        }

        // Fall through to agent-initiated flow.
        const { resolveOAuthCallback } = await import('./oauth-skills.js');
        const found = await resolveOAuthCallback(provider, code, state, providers.credentials, eventBus);

        const html = found
          ? '<html><body><h2>Authentication successful</h2><p>You can close this tab and return to your conversation.</p></body></html>'
          : '<html><body><h2>Authentication failed</h2><p>Invalid or expired OAuth flow. Please try again.</p></body></html>';
        const status = found ? 200 : 400;
        res.writeHead(status, { 'Content-Type': 'text/html', 'Content-Length': String(Buffer.byteLength(html)) });
        res.end(html);
      } catch (err) {
        logger.error('oauth_callback_failed', { provider, error: (err as Error).message });
        const html = '<html><body><h2>Server error</h2><p>OAuth callback processing failed. Please try again.</p></body></html>';
        res.writeHead(500, { 'Content-Type': 'text/html', 'Content-Length': String(Buffer.byteLength(html)) });
        res.end(html);
      }
      return;
    }

    // Chat API
    if (url.startsWith('/v1/chat/sessions')) {
      if (chatApiHandler) {
        const handled = await chatApiHandler(req, res, url);
        if (handled) return;
      }
    }

    // Auth routes — delegate to auth provider handleRequest
    if (url.startsWith('/api/auth/') && authProviders?.length) {
      for (const ap of authProviders) {
        if (ap.handleRequest) {
          const handled = await ap.handleRequest(req, res);
          if (handled) return;
        }
      }
    }

    // Admin dashboard
    if (adminHandler && url.startsWith('/admin')) {
      try {
        await adminHandler(req, res, url.split('?')[0]);
      } catch (err) {
        logger.error('admin_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Admin request failed');
      }
      return;
    }

    // Mode-specific routes (k8s /internal/*, etc.)
    if (extraRoutes) {
      const handled = await extraRoutes(req, res, url);
      if (handled) return;
    }

    // Chat UI (SPA fallback for non-API, non-admin routes)
    // Don't serve /v1/* or /admin* or /health as SPA — those are API routes
    if (chatUIHandler && !url.startsWith('/v1/') && !url.startsWith('/admin') && !url.startsWith('/api/auth/') && url !== '/health') {
      chatUIHandler(req, res, url);
      return;
    }

    sendError(res, 404, 'Not found');
  };
}
