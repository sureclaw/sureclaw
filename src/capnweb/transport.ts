/**
 * Length-prefixed RpcTransport over a Node.js net.Socket.
 *
 * Framing: [4-byte BE length][UTF-8 message]
 * Same framing as AX's IPC protocol, but on a separate socket
 * dedicated to Cap'n Web RPC.
 */

import type { Socket } from 'node:net';

/**
 * Cap'n Web RpcTransport compatible interface.
 * We declare it here to avoid importing capnweb in the shared module —
 * the agent-side runtime bundles this inline.
 */
export interface RpcTransport {
  send(message: string): Promise<void>;
  receive(): Promise<string>;
  abort?(reason: unknown): void;
}

export class SocketRpcTransport implements RpcTransport {
  private buffer = Buffer.alloc(0);
  private messageQueue: string[] = [];
  private waiters: Array<{ resolve: (msg: string) => void; reject: (err: Error) => void }> = [];
  private closed = false;
  private closeReason: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', (err: Error) => this.onError(err));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private drain(): void {
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const msg = this.buffer.subarray(4, 4 + len).toString('utf8');
      this.buffer = this.buffer.subarray(4 + len);
      this.deliver(msg);
    }
  }

  private deliver(msg: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  private onClose(): void {
    this.closed = true;
    this.closeReason ??= new Error('Socket closed');
    for (const waiter of this.waiters) {
      waiter.reject(this.closeReason);
    }
    this.waiters.length = 0;
  }

  private onError(err: Error): void {
    this.closeReason = err;
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error('Transport closed');
    const payload = Buffer.from(message, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.concat([header, payload]), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  receive(): Promise<string> {
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error('Transport closed'));
    }
    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  abort(reason?: unknown): void {
    this.closeReason = reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
    this.socket.destroy();
  }

  dispose(): void {
    this.abort(new Error('disposed'));
  }
}
