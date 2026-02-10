import { connect, type Socket } from 'node:net';
import { debug, truncate } from '../logger.js';

const SRC = 'container:ipc-client';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface IPCClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export class IPCClient {
  private socketPath: string;
  private timeoutMs: number;
  private socket: Socket | null = null;
  private connected = false;

  constructor(opts: IPCClientOptions) {
    this.socketPath = opts.socketPath;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    debug(SRC, 'connect_start', { socketPath: this.socketPath });
    return new Promise<void>((resolve, reject) => {
      this.socket = connect(this.socketPath, () => {
        this.connected = true;
        debug(SRC, 'connect_ok', { socketPath: this.socketPath });
        resolve();
      });
      this.socket.on('error', (err) => {
        this.connected = false;
        debug(SRC, 'connect_error', { error: err.message });
        reject(err);
      });
    });
  }

  async call(request: Record<string, unknown>, callTimeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.socket || !this.connected) {
      await this.connect();
    }

    const action = request.action as string ?? 'unknown';
    const callStart = Date.now();
    const socket = this.socket!;
    const payload = Buffer.from(JSON.stringify(request), 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);

    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;
    debug(SRC, 'call_start', { action, payloadBytes: payload.length, timeoutMs: effectiveTimeout });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        debug(SRC, 'call_timeout', { action, timeoutMs: effectiveTimeout });
        reject(new Error(`IPC call timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);

      let buffer = Buffer.alloc(0);

      const onData = (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (buffer.length < 4) return;

        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) return;

        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);

        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        const durationMs = Date.now() - callStart;
        try {
          const parsed = JSON.parse(raw);
          debug(SRC, 'call_done', {
            action,
            ok: parsed.ok,
            responseBytes: msgLen,
            durationMs,
            ...(parsed.error ? { error: truncate(String(parsed.error)) } : {}),
          });
          resolve(parsed);
        } catch {
          debug(SRC, 'call_error', { action, error: 'Invalid JSON in response', durationMs });
          reject(new Error('Invalid JSON in IPC response'));
        }
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        socket.off('data', onData);
        debug(SRC, 'call_error', { action, error: err.message, durationMs: Date.now() - callStart });
        reject(err);
      };

      socket.on('data', onData);
      socket.once('error', onError);

      // Send: length prefix + payload
      socket.write(Buffer.concat([lenBuf, payload]));
    });
  }

  disconnect(): void {
    if (this.socket) {
      debug(SRC, 'disconnect');
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}
