import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { CdpClient, CdpTransport } from "../chrome/cdp-client.js";
import type { CdpMessage } from "../chrome/pipe-transport.js";
import { isMethodAllowed } from "./cdp-filter.js";
import type { DaemonBlindModeState } from "../services-blind.js";

export interface ProxyServer {
  url: string;
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

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (url.pathname !== `/cdp/${token}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wireSocket(ws));
  });

  function wireSocket(ws: WebSocket): void {
    const onChrome = (msg: unknown) => {
      const m = msg as CdpMessage;
      const method = m.method ?? "";
      // Chrome → agent path. Events have a method but no id.
      // Drop sensitive events while blind mode is active so that pre-enabled
      // subscriptions (Runtime.consoleAPICalled, Network.responseReceived,
      // Page.screencastFrame, etc.) cannot leak page content to the agent.
      if (method !== "" && m.id === undefined) {
        const blindOn = opts.blind.current() !== null;
        if (blindOn && !isMethodAllowed(method, true)) {
          return;
        }
      }
      ws.send(JSON.stringify(m));
    };
    opts.transport.on("message", onChrome);
    ws.on("close", () => opts.transport.removeListener("message", onChrome));
    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString("utf8")) as CdpMessage;
        const method = msg.method ?? "";
        const blindOn = opts.blind.current() !== null;
        if (method !== "" && !isMethodAllowed(method, blindOn)) {
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
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
}
