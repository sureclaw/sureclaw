import { connect, type Socket } from 'node:net';

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

    return new Promise<void>((resolve, reject) => {
      this.socket = connect(this.socketPath, () => {
        this.connected = true;
        resolve();
      });
      this.socket.on('error', (err) => {
        this.connected = false;
        reject(err);
      });
    });
  }

  async call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.socket || !this.connected) {
      await this.connect();
    }

    const socket = this.socket!;
    const payload = Buffer.from(JSON.stringify(request), 'utf-8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`IPC call timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

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
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('Invalid JSON in IPC response'));
        }
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        socket.off('data', onData);
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
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}
