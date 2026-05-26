import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

export class PipeTransport extends EventEmitter {
  private buf = Buffer.alloc(0);
  private closed = false;
  constructor(
    private readonly inStream: Readable,
    private readonly outStream: Writable,
  ) {
    super();
    inStream.on("data", (chunk: Buffer) => this.onChunk(chunk));
    inStream.on("close", () => this.emit("close"));
  }

  send(message: CdpMessage): void {
    const line = Buffer.from(JSON.stringify(message), "utf8");
    this.outStream.write(line);
    this.outStream.write(Buffer.from([0]));
  }

  /**
   * Idempotently tears down the transport: stops processing further chunks
   * from the readable side and ends the writable side. The owning child
   * process is killed separately by the caller (see `launch.ts`).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.inStream.removeAllListeners("data");
    } catch { /* best-effort */ }
    try {
      this.outStream.end();
    } catch { /* best-effort */ }
  }

  private onChunk(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    let nul: number;
    while ((nul = this.buf.indexOf(0)) !== -1) {
      const frame = this.buf.subarray(0, nul);
      this.buf = this.buf.subarray(nul + 1);
      try {
        const msg = JSON.parse(frame.toString("utf8")) as CdpMessage;
        this.emit("message", msg);
      } catch {
        this.emit("error", new Error("Invalid CDP frame."));
      }
    }
  }
}

export function spawnChromePipe(
  chromePath: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): {
  child: ChildProcessWithoutNullStreams;
  transport: PipeTransport;
} {
  const child = spawn(chromePath, [...args, "--remote-debugging-pipe"], {
    stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"],
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }) as ChildProcessWithoutNullStreams;

  const writeStream = (child.stdio as unknown[])[3] as Writable;
  const readStream = (child.stdio as unknown[])[4] as Readable;
  const transport = new PipeTransport(readStream, writeStream);
  return { child, transport };
}
