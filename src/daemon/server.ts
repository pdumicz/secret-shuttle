import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ShuttleError, errorToJson } from "../shared/errors.js";
import { parseBearer, deriveHmac } from "./auth/token-derive.js";
import { withAuthContext, type AuthContext } from "./auth/auth-context.js";

type RouteHandler = (req: IncomingMessage, body: unknown) => Promise<unknown> | unknown;
type RawHandler = (req: IncomingMessage, body: unknown, res: ServerResponse) => Promise<void> | void;
// Like RawHandler but auth-gated (Host + bearer checked before invocation).
type StreamingHandler = (
  req: IncomingMessage,
  body: unknown,
  res: ServerResponse,
) => Promise<void> | void;
type Method = "GET" | "POST" | "DELETE";

export interface DaemonServerOptions {
  token: string;
}

const ALLOWED_HOST_PREFIXES = ["127.0.0.1:", "localhost:", "[::1]:"];
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

export class DaemonServer {
  private token: string;
  private readonly routes = new Map<string, RouteHandler>();
  private readonly rawRoutes: { method: Method; pattern: RegExp; handler: RawHandler }[] = [];
  private readonly streamingRoutes = new Map<string, StreamingHandler>();
  private server: Server | null = null;
  private port = 0;

  constructor(opts: DaemonServerOptions) {
    this.token = opts.token;
  }

  /**
   * Hot-swap the in-memory root token. Used by /v1/daemon/rotate (Task A13)
   * to atomically invalidate the previous token + all derived agent tokens.
   * JS is single-threaded so the assignment is atomic; in-flight requests
   * that already passed auth continue running under the OLD token's
   * AuthContext (correct — their work was authorized).
   */
  replaceRootToken(t: string): void {
    this.token = t;
  }

  /**
   * Read the current in-memory root token. Used by /v1/tokens/mint (Task A12)
   * via a closure passed to its route registrar — every mint reads the CURRENT
   * token at call time, so a hot-swap from replaceRootToken() takes effect on
   * the very next mint request without re-registering the route. Exposing this
   * is safe because the daemon binds to 127.0.0.1 only and all calls are
   * bearer-gated before reaching any handler.
   */
  getRootToken(): string {
    return this.token;
  }

  addRoute(method: Method, path: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  /**
   * Register a raw route that bypasses Host-header AND bearer-token checks.
   * The handler MUST perform its own authentication (e.g., a URL-embedded per-request
   * token, as the Approval UI does). Raw routes are intentionally unreachable from
   * external networks because the server binds to 127.0.0.1 only.
   */
  addRouteRaw(method: Method, pattern: RegExp, handler: RawHandler): void {
    this.rawRoutes.push({ method, pattern, handler });
  }

  /**
   * Register a route whose handler controls the response body (e.g. for chunked
   * line-delimited JSON streaming). Identical Host + bearer-token + 1 MB body
   * cap to addRoute — auth runs BEFORE the handler is invoked, so an unauthorized
   * request never reaches `spawn()` or any other side-effectful code.
   *
   * Use this for /v1/run/resolve and similar endpoints. addRouteRaw remains for
   * UI routes that authenticate via a per-URL token (see ui-server.ts).
   */
  addRouteStreaming(method: Method, path: string, handler: StreamingHandler): void {
    this.streamingRoutes.set(`${method} ${path}`, handler);
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
      // writeError defaults to 400 for ShuttleError, which matches bad_host's HTTP status.
      this.writeError(res, new ShuttleError("bad_host", `Rejected host: ${host}`));
      return;
    }

    // Bearer token auth + AsyncLocalStorage wrap.
    const authHeader = req.headers["authorization"];
    const auth = Array.isArray(authHeader) ? (authHeader[0] ?? "") : (authHeader ?? "");
    const BEARER = "Bearer ";
    if (!auth.startsWith(BEARER)) {
      this.writeUnauthorized(res);
      return;
    }
    const bearer = auth.slice(BEARER.length);

    let authCtx: AuthContext;
    try {
      const parsed = parseBearer(bearer);
      if (parsed.kind === "root") {
        const expected = Buffer.from(this.token);
        const actual = Buffer.from(parsed.token);
        if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
          this.writeUnauthorized(res);
          return;
        }
        authCtx = { agent_id: "root", isRoot: true };
      } else {
        const expectedHmac = deriveHmac(this.token, parsed.agentId);
        const expected = Buffer.from(expectedHmac);
        const actual = Buffer.from(parsed.hmac);
        if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
          this.writeUnauthorized(res);
          return;
        }
        authCtx = { agent_id: parsed.agentId, isRoot: false };
      }
    } catch {
      // parseBearer can throw ShuttleError(agent_token_invalid) for reserved 'root'
      // agent_id or malformed agent_id charset. Surface uniformly as 401 unauthorized
      // — don't leak the specific parse failure to unauthenticated callers.
      this.writeUnauthorized(res);
      return;
    }

    await withAuthContext(authCtx, async () => {
      await this.dispatchHandler(req, res, urlPath);
    });
  }

  private writeUnauthorized(res: ServerResponse): void {
    const err = new ShuttleError("unauthorized", "Invalid or missing bearer token.");
    const payload = errorToJson(err);
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  }

  private async dispatchHandler(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
    const streamingKey = `${req.method ?? "GET"} ${urlPath}`;
    const streamingHandler = this.streamingRoutes.get(streamingKey);
    if (streamingHandler !== undefined) {
      const body = req.method === "GET" ? null : await readJsonBody(req);
      try {
        await streamingHandler(req, body, res);
      } catch (e) {
        if (res.headersSent) {
          // Headers already flushed (the streaming handler began writing then
          // threw). We cannot safely write a JSON error envelope. Destroy the
          // socket to signal an incomplete response to the client.
          res.destroy(e instanceof Error ? e : new Error(String(e)));
        } else {
          // Streaming handler threw before flushing — safe to send a JSON error.
          this.writeError(res, e);
        }
      }
      return;
    }

    const key = `${req.method ?? "GET"} ${urlPath}`;
    const handler = this.routes.get(key);
    if (handler === undefined) {
      // writeError defaults to 400; override to 404 to preserve HTTP semantics.
      const err = new ShuttleError("not_found", `No route for ${req.method ?? "GET"} ${urlPath}`);
      const payload = errorToJson(err);
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    const body = req.method === "GET" ? null : await readJsonBody(req);
    const result = await handler(req, body);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ...(result as Record<string, unknown>) }));
  }

  private writeError(res: ServerResponse, err: unknown): void {
    if (res.writableEnded) return;
    const payload = errorToJson(err);
    res.statusCode = err instanceof ShuttleError ? 400 : 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new ShuttleError("request_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ShuttleError("invalid_json", "Request body is not valid JSON.");
  }
}
