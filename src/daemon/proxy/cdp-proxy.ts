import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { CdpClient, CdpTransport } from "../chrome/cdp-client.js";
import type { CdpMessage } from "../chrome/pipe-transport.js";
import { isMethodAllowed } from "./cdp-filter.js";
import type { DaemonBlindModeState } from "../services-blind.js";

export interface ProxyServer {
  url: string;
  severAgentConnections(): void;
  close(): Promise<void>;
}

export async function startCdpProxy(opts: {
  transport: CdpTransport;
  cdp: CdpClient;
  blind: DaemonBlindModeState;
}): Promise<ProxyServer> {
  const token = randomBytes(24).toString("base64url");
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (url.pathname !== `/cdp/${token}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wireSocket(ws));
  });

  function wireSocket(ws: WebSocket): void {
    sockets.add(ws);
    const onChrome = (msg: unknown) => {
      const m = msg as CdpMessage;
      // BLIND MODE = TOTAL CHROME→AGENT BLACKOUT.
      // Drop everything — events AND responses (including responses to requests
      // the agent issued before blind mode, e.g. a pre-armed awaitPromise
      // Runtime.evaluate that resolves while the secret is on screen).
      if (opts.blind.current() !== null) {
        return;
      }
      ws.send(JSON.stringify(m));
    };
    opts.transport.on("message", onChrome);
    ws.on("close", () => {
      sockets.delete(ws);
      opts.transport.removeListener("message", onChrome);
    });
    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString("utf8")) as CdpMessage;
        const blindOn = opts.blind.current() !== null;
        // In blind mode every inbound method is blocked; outside blind mode allow all.
        const method = msg.method ?? "";
        if (blindOn || (method !== "" && !isMethodAllowed(method, blindOn))) {
          if (typeof msg.id === "number") {
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32603, message: "cdp_method_blocked" } }));
          }
          return;
        }
        opts.transport.send(msg);
      } catch {
        // ignore malformed frames
      }
    });
  }

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Proxy failed to bind");
  }
  return {
    url: `ws://127.0.0.1:${addr.port}/cdp/${token}`,
    severAgentConnections: () => {
      for (const ws of sockets) {
        try { ws.close(1000, "blind_mode_active"); } catch { /* best-effort */ }
        try { ws.terminate(); } catch { /* force-kill if close hangs */ }
      }
      sockets.clear();
    },
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
}
