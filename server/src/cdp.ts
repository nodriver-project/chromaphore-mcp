// A CDP connection over --remote-debugging-pipe: commands go to the browser's
// file descriptor 3 and answers and events come from its 4, each message one
// JSON text ended by a NUL byte.
import type { Readable, Writable } from 'node:stream';

export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

// An error answer from the browser. `message` is the browser's own text, so
// callers can match the documented error strings.
export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class Connection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout }
  >();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private chunks: Buffer[] = [];
  closed = false;
  closeReason = '';

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.on('data', (chunk: Buffer) => this.onData(chunk));
    input.on('end', () => this.onClose('the browser closed the connection'));
    input.on('error', (e) => this.onClose(e.message));
    out.on('error', (e) => this.onClose(e.message));
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`the browser is gone (${this.closeReason})`));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.out.write(JSON.stringify(message) + '\0');
    });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Closing the pipe makes the browser close itself.
  close(): void {
    this.out.end();
  }

  private onData(chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, start)) {
      this.chunks.push(chunk.subarray(start, i));
      const text = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      start = i + 1;
      this.dispatch(JSON.parse(text));
    }
    if (start < chunk.length) this.chunks.push(chunk.subarray(start));
  }

  private dispatch(message: any): void {
    if (message.id !== undefined) {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error) p.reject(new CdpError(p.method, message.error.code, message.error.message));
      else p.resolve(message.result);
      return;
    }
    for (const l of this.listeners) {
      try {
        l(message);
      } catch {
        // A listener's failure must not stop the others.
      }
    }
  }

  private onClose(why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = why;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`the browser is gone (${why})`));
    }
    this.pending.clear();
    for (const l of this.listeners) l({ method: 'Connection.closed', params: { why } });
  }
}
