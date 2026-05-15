import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ShuttleError, errorToJson } from "../shared/errors.js";

type RouteHandler = (req: IncomingMessage, body: unknown) => Promise<unknown> | unknown;
type RawHandler = (req: IncomingMessage, body: unknown, res: ServerResponse) => Promise<void> | void;
type Method = "GET" | "POST" | "DELETE";

export interface DaemonServerOptions {
  token: string;
}

const ALLOWED_HOST_PREFIXES = ["127.0.0.1:", "localhost:", "[::1]:"];

export class DaemonServer {
  private readonly token: string;
  private readonly routes = new Map<string, RouteHandler>();
  private readonly rawRoutes: { method: Method; pattern: RegExp; handler: RawHandler }[] = [];
  private server: Server | null = null;
  private port = 0;

  constructor(opts: DaemonServerOptions) {
    this.token = opts.token;
  }

  addRoute(method: Method, path: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  addRouteRaw(method: Method, pattern: RegExp, handler: RawHandler): void {
    this.rawRoutes.push({ method, pattern, handler });
  }

  async listen(port = 0): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => this.writeError(res, err));
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Daemon failed to bind"));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve({ port: address.port });
      });
    });
  }

  async close(): Promise<void> {
    const s = this.server;
    if (s === null) return;
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err === undefined ? resolve() : reject(err)));
    });
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`).pathname;

    // Raw routes (skip bearer + JSON wrap)
    for (const r of this.rawRoutes) {
      if (r.method === req.method && r.pattern.test(urlPath)) {
        try {
          await r.handler(req, null, res);
        } catch (e) {
          this.writeError(res, e);
        }
        return;
      }
    }

    // Host header validation
    const hostHeader = req.headers["host"];
    const host = Array.isArray(hostHeader) ? (hostHeader[0] ?? "") : (hostHeader ?? "");
    if (!ALLOWED_HOST_PREFIXES.some((p) => host.startsWith(p))) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: { code: "bad_host" } }));
      return;
    }

    // Bearer token auth
    const authHeader = req.headers["authorization"];
    const auth = Array.isArray(authHeader) ? (authHeader[0] ?? "") : (authHeader ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    const actual = Buffer.from(auth);
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: { code: "unauthorized" } }));
      return;
    }

    const key = `${req.method ?? "GET"} ${urlPath}`;
    const handler = this.routes.get(key);
    if (handler === undefined) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: { code: "not_found" } }));
      return;
    }

    const body = req.method === "GET" ? null : await readJsonBody(req);
    const result = await handler(req, body);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ...(result as Record<string, unknown>) }));
  }

  private writeError(res: ServerResponse, err: unknown): void {
    const payload = errorToJson(err);
    res.statusCode = err instanceof ShuttleError ? 400 : 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
