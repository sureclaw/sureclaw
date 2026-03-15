import { connect, createServer, type Socket, type Server } from 'node:net';
import { getLogger, truncate } from '../logger.js';

const logger = getLogger().child({ component: 'ipc-client' });

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 500;

export interface IPCClientOptions {
  socketPath: string;
  timeoutMs?: number;
  /** Maximum reconnection attempts on connection loss. Default: 3. */
  maxReconnectAttempts?: number;
  /** Session ID included in every IPC request for host-side scoping. */
  sessionId?: string;
  /** HTTP request ID included in every IPC request for event bus routing. */
  requestId?: string;
  /** User ID included in every IPC request for per-user scoping. */
  userId?: string;
  /** Session scope included in every IPC request for memory scoping (dm = user-scoped, channel = agent-scoped). */
  sessionScope?: string;
  /** If true, listen for an incoming connection instead of connecting out.
   *  Used by Apple Container sandbox where the host connects into the VM
   *  via --publish-socket and the agent accepts the connection. */
  listen?: boolean;
}

interface PendingCall {
  action: string;
  callStart: number;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

export class IPCClient {
  private socketPath: string;
  private timeoutMs: number;
  private maxReconnectAttempts: number;
  private sessionId?: string;
  private requestId?: string;
  private userId?: string;
  private sessionScope?: string;
  private socket: Socket | null = null;
  private connected = false;
  private listenMode: boolean;
  private listenServer: Server | null = null;
  private connectPromise: Promise<void> | null = null;

  /** Pending calls awaiting responses, keyed by _msgId. */
  private pending = new Map<string, PendingCall>();
  /** Shared receive buffer for the data handler. */
  private recvBuffer = Buffer.alloc(0);
  /** Incrementing message ID counter — unique per connection. */
  private nextMsgId = 0;
  /** Whether the shared data handler is installed on the current socket. */
  private handlerInstalled = false;

  constructor(opts: IPCClientOptions) {
    this.socketPath = opts.socketPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
    this.sessionId = opts.sessionId;
    this.requestId = opts.requestId;
    this.userId = opts.userId;
    this.sessionScope = opts.sessionScope;
    this.listenMode = opts.listen ?? false;
  }

  /**
   * Update session context after construction.
   * Used by Apple Container listen mode where the IPCClient is created before
   * stdin is parsed (to start the listener early), then session context is
   * applied once the stdin payload arrives with the host-assigned sessionId.
   */
  setContext(ctx: { sessionId?: string; requestId?: string; userId?: string; sessionScope?: string }): void {
    if (ctx.sessionId !== undefined) this.sessionId = ctx.sessionId;
    if (ctx.requestId !== undefined) this.requestId = ctx.requestId;
    if (ctx.userId !== undefined) this.userId = ctx.userId;
    if (ctx.sessionScope !== undefined) this.sessionScope = ctx.sessionScope;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    // If a connect/listen is already in progress, return the same promise
    // instead of starting a second one (prevents EADDRINUSE in listen mode).
    if (this.connectPromise) return this.connectPromise;

    if (this.listenMode) {
      // Listen mode: create a server, wait for the host to connect in.
      // Used by Apple Container sandbox where --publish-socket forwards
      // host connections into the VM via virtio-vsock.
      logger.debug('listen_start', { socketPath: this.socketPath });
      this.connectPromise = new Promise<void>((resolve, reject) => {
        this.listenServer = createServer();
        this.listenServer.once('connection', (socket: Socket) => {
          this.socket = socket;
          this.connected = true;
          this.connectPromise = null;
          // Close the listen server — we only need one connection (the bridge).
          // Leaving it open would accept kernel-level connections that we never
          // handle, wasting file descriptors.
          this.listenServer?.close();
          this.listenServer = null;
          process.stderr.write(`[diag] ipc_listen_accepted path=${this.socketPath}\n`);
          logger.debug('listen_accepted', { socketPath: this.socketPath });
          this.installSharedHandler();
          resolve();
        });
        this.listenServer.on('error', (err) => {
          this.connectPromise = null;
          process.stderr.write(`[diag] ipc_listen_error error=${err.message}\n`);
          logger.debug('listen_error', { error: err.message });
          reject(err);
        });
        // Signal readiness via stderr AFTER the server is bound and accepting
        // connections. The host watches for this signal before connecting the
        // bridge — without it, the host connects before the listener is ready
        // and the publish-socket runtime can't forward the connection.
        this.listenServer.listen(this.socketPath, () => {
          process.stderr.write(`[signal] ipc_ready\n`);
          logger.debug('listen_ready', { socketPath: this.socketPath });
        });
      });
      return this.connectPromise;
    }

    logger.debug('connect_start', { socketPath: this.socketPath });
    return new Promise<void>((resolve, reject) => {
      this.socket = connect(this.socketPath, () => {
        this.connected = true;
        logger.debug('connect_ok', { socketPath: this.socketPath });
        this.installSharedHandler();
        resolve();
      });
      this.socket.on('error', (err) => {
        this.connected = false;
        logger.debug('connect_error', { error: err.message });
        reject(err);
      });
    });
  }

  /**
   * Install a single shared data handler on the socket.
   * Routes incoming messages to the correct pending call by _msgId.
   */
  private installSharedHandler(): void {
    if (this.handlerInstalled || !this.socket) return;
    this.handlerInstalled = true;
    this.recvBuffer = Buffer.alloc(0);

    this.socket.on('data', (data: Buffer) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, data]);

      while (this.recvBuffer.length >= 4) {
        const msgLen = this.recvBuffer.readUInt32BE(0);
        if (this.recvBuffer.length < 4 + msgLen) return; // wait for more data

        const raw = this.recvBuffer.subarray(4, 4 + msgLen).toString('utf-8');
        this.recvBuffer = this.recvBuffer.subarray(4 + msgLen);

        try {
          const parsed = JSON.parse(raw);

          if (parsed._heartbeat) {
            const msgId = parsed._msgId as string | undefined;
            if (msgId && this.pending.has(msgId)) {
              // Heartbeat for a specific call — reset that call's timer
              this.resetTimer(msgId);
            } else {
              // Heartbeat without _msgId — reset all pending timers
              for (const id of this.pending.keys()) {
                this.resetTimer(id);
              }
            }
            logger.debug('heartbeat_received', { ts: parsed.ts, msgId });
            continue;
          }

          // Route response to the matching pending call by _msgId.
          // Fallback: if the response has no _msgId (old host), deliver to the
          // oldest pending call (FIFO) — preserves backward compatibility but
          // concurrent calls may still misroute without correlation IDs.
          const msgId = parsed._msgId as string | undefined;
          let entry: PendingCall | undefined;
          let resolvedId: string | undefined;

          if (msgId && this.pending.has(msgId)) {
            entry = this.pending.get(msgId)!;
            resolvedId = msgId;
          } else if (!msgId && this.pending.size > 0) {
            // FIFO fallback for hosts that don't echo _msgId
            resolvedId = this.pending.keys().next().value!;
            entry = this.pending.get(resolvedId)!;
            logger.debug('fifo_fallback', { resolvedId, action: entry.action });
          }

          if (entry && resolvedId) {
            this.pending.delete(resolvedId);
            clearTimeout(entry.timer);
            const durationMs = Date.now() - entry.callStart;
            logger.debug('call_done', {
              action: entry.action,
              ok: parsed.ok,
              responseBytes: msgLen,
              durationMs,
              ...(parsed.error ? { error: truncate(String(parsed.error)) } : {}),
            });
            entry.resolve(parsed);
          } else {
            // Response has _msgId but no matching pending call — likely stale
            logger.debug('unmatched_response', { msgId, ok: parsed.ok, responseBytes: msgLen });
          }
        } catch {
          logger.debug('parse_error', { rawPreview: raw.slice(0, 200) });
        }
      }
    });

    this.socket.on('error', (err: Error) => {
      this.connected = false;
      logger.debug('socket_error', { error: err.message });
      // Reject all pending calls
      this.rejectAllPending(err);
    });
  }

  /** Reset the timeout timer for a pending call. */
  private resetTimer(msgId: string): void {
    const entry = this.pending.get(msgId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.pending.delete(msgId);
      logger.debug('call_timeout', { action: entry.action, timeoutMs: entry.timeoutMs });
      entry.reject(new Error(`IPC call timed out (no heartbeat for ${entry.timeoutMs}ms)`));
    }, entry.timeoutMs);
  }

  /** Reject all pending calls with an error. */
  private rejectAllPending(err: Error): void {
    for (const [msgId, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(msgId);
      entry.reject(err);
    }
  }

  /**
   * Reconnect to the IPC socket with exponential backoff.
   * Tears down the old socket before each attempt.
   */
  private async reconnect(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
      // Tear down stale socket and reject pending calls
      if (this.socket) {
        this.rejectAllPending(new Error('IPC connection lost'));
        try { this.socket.destroy(); } catch { /* ignore */ }
        this.socket = null;
        this.connected = false;
        this.handlerInstalled = false;
      }

      const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.debug('reconnect_attempt', { attempt, maxAttempts: this.maxReconnectAttempts, delayMs: delay });
      await new Promise<void>(r => setTimeout(r, delay));

      try {
        await this.connect();
        logger.debug('reconnect_success', { attempt });
        return;
      } catch (err) {
        logger.debug('reconnect_failed', { attempt, error: (err as Error).message });
        if (attempt >= this.maxReconnectAttempts) {
          throw new Error(`IPC reconnect failed after ${this.maxReconnectAttempts} attempts: ${(err as Error).message}`);
        }
      }
    }
  }

  async call(request: Record<string, unknown>, callTimeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.socket || !this.connected) {
      await this.connect();
    }

    try {
      return await this.callOnce(request, callTimeoutMs);
    } catch (err) {
      // On connection-level errors (EPIPE, ECONNRESET, socket destroyed), retry once after reconnect.
      // Timeouts and application-level errors are NOT retried — they indicate the call was received.
      if (this.isConnectionError(err)) {
        logger.debug('call_connection_error', {
          action: request.action,
          error: (err as Error).message,
          willReconnect: true,
        });
        await this.reconnect();
        return await this.callOnce(request, callTimeoutMs);
      }
      throw err;
    }
  }

  private callOnce(request: Record<string, unknown>, callTimeoutMs?: number): Promise<Record<string, unknown>> {
    const action = request.action as string ?? 'unknown';
    const callStart = Date.now();
    const socket = this.socket!;
    const msgId = String(++this.nextMsgId);
    const enriched = {
      ...request,
      _msgId: msgId,
      ...(this.sessionId ? { _sessionId: this.sessionId } : {}),
      ...(this.requestId ? { _requestId: this.requestId } : {}),
      ...(this.userId ? { _userId: this.userId } : {}),
      ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
    };
    const payload = Buffer.from(JSON.stringify(enriched), 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);

    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;
    logger.debug('call_start', { action, msgId, payloadBytes: payload.length, timeoutMs: effectiveTimeout });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msgId);
        logger.debug('call_timeout', { action, timeoutMs: effectiveTimeout });
        reject(new Error(`IPC call timed out (no heartbeat for ${effectiveTimeout}ms)`));
      }, effectiveTimeout);

      this.pending.set(msgId, { action, callStart, timeoutMs: effectiveTimeout, timer, resolve, reject });

      // Send: length prefix + payload
      socket.write(Buffer.concat([lenBuf, payload]));
    });
  }

  /** Classify whether an error is a connection-level failure (worth reconnecting for). */
  private isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes('epipe') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('socket') ||
      msg.includes('destroyed') ||
      msg.includes('not connected') ||
      msg.includes('this socket has been ended') ||
      // Don't retry timeouts — the call may have been received
      false
    );
  }

  disconnect(): void {
    this.rejectAllPending(new Error('IPC client disconnected'));
    if (this.socket) {
      logger.debug('disconnect');
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      this.handlerInstalled = false;
    }
    if (this.listenServer) {
      this.listenServer.close();
      this.listenServer = null;
    }
  }
}
