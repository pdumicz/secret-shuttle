import type { CdpMessage } from "./pipe-transport.js";

export interface CdpTransport {
  send(message: CdpMessage): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, ((p: unknown, sessionId?: string) => void)[]>();

  constructor(private readonly transport: CdpTransport) {
    this.transport.on("message", (msg) => this.onMessage(msg as CdpMessage));
  }

  send<T = unknown>(method: string, params?: unknown, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const msg: CdpMessage = {
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send(msg);
    });
  }

  on(event: string, fn: (params: unknown, sessionId?: string) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
  }

  off(event: string, fn: (params: unknown, sessionId?: string) => void): void {
    const arr = this.listeners.get(event);
    if (arr === undefined) return;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  }

  private onMessage(msg: CdpMessage): void {
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    }
  }
}
