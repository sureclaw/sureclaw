import { connect, type Socket } from 'node:net';
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
  /** User ID included in every IPC request for per-user scoping. */
  userId?: string;
  /** Session scope included in every IPC request for memory scoping (dm = user-scoped, channel = agent-scoped). */
  sessionScope?: string;
}

export class IPCClient {
  private socketPath: string;
  private timeoutMs: number;
  private maxReconnectAttempts: number;
  private sessionId?: string;
  private userId?: string;
  private sessionScope?: string;
  private socket: Socket | null = null;
  private connected = false;

  constructor(opts: IPCClientOptions) {
    this.socketPath = opts.socketPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this.sessionScope = opts.sessionScope;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    logger.debug('connect_start', { socketPath: this.socketPath });
    return new Promise<void>((resolve, reject) => {
      this.socket = connect(this.socketPath, () => {
        this.connected = true;
        logger.debug('connect_ok', { socketPath: this.socketPath });
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
   * Reconnect to the IPC socket with exponential backoff.
   * Tears down the old socket before each attempt.
   */
  private async reconnect(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
      // Tear down stale socket
      if (this.socket) {
        try { this.socket.destroy(); } catch { /* ignore */ }
        this.socket = null;
        this.connected = false;
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
    const enriched = {
      ...request,
      ...(this.sessionId ? { _sessionId: this.sessionId } : {}),
      ...(this.userId ? { _userId: this.userId } : {}),
      ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
    };
    const payload = Buffer.from(JSON.stringify(enriched), 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);

    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;
    logger.debug('call_start', { action, payloadBytes: payload.length, timeoutMs: effectiveTimeout });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let timer = setTimeout(() => {
        logger.debug('call_timeout', { action, timeoutMs: effectiveTimeout });
        reject(new Error(`IPC call timed out (no heartbeat for ${effectiveTimeout}ms)`));
      }, effectiveTimeout);

      let buffer = Buffer.alloc(0);

      const onData = (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        while (buffer.length >= 4) {
          const msgLen = buffer.readUInt32BE(0);
          if (buffer.length < 4 + msgLen) return; // wait for more data

          const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
          buffer = buffer.subarray(4 + msgLen);

          const durationMs = Date.now() - callStart;
          try {
            const parsed = JSON.parse(raw);

            if (parsed._heartbeat) {
              // Reset timeout — server is alive
              clearTimeout(timer);
              timer = setTimeout(() => {
                logger.debug('call_timeout', { action, timeoutMs: effectiveTimeout });
                reject(new Error(`IPC call timed out (no heartbeat for ${effectiveTimeout}ms)`));
              }, effectiveTimeout);
              logger.debug('heartbeat_received', { action, ts: parsed.ts });
              continue; // keep listening for more frames
            }

            // Regular response — resolve
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            logger.debug('call_done', {
              action,
              ok: parsed.ok,
              responseBytes: msgLen,
              durationMs,
              ...(parsed.error ? { error: truncate(String(parsed.error)) } : {}),
            });
            resolve(parsed);
            return;
          } catch {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            logger.debug('call_error', { action, error: 'Invalid JSON in response', durationMs });
            reject(new Error('Invalid JSON in IPC response'));
            return;
          }
        }
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        socket.off('data', onData);
        logger.debug('call_error', { action, error: err.message, durationMs: Date.now() - callStart });
        // Mark as disconnected so reconnect is triggered
        this.connected = false;
        reject(err);
      };

      socket.on('data', onData);
      socket.once('error', onError);

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
    if (this.socket) {
      logger.debug('disconnect');
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}
