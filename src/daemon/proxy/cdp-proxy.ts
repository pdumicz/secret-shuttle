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

  // Epoch is incremented every time blind mode starts (via severAgentConnections).
  // Responses whose pending entry carries a stale epoch are dropped — this is the
  // cross-blind-cycle reconnect-leak fix.
  let epoch = 0;

  // Proxy-allocated CDP ids start at 1_000_000_000 so they never collide with the
  // daemon's own CdpClient id space (which starts at 1 and stays tiny).
  let nextProxyId = 1_000_000_000;

  // proxyId → { ws, originalId, epoch } — who sent the request and what id they used.
  const pending = new Map<number, { ws: WebSocket; originalId: number; epoch: number }>();

  // Single outbound listener registered ONCE — not per socket.
  const onChrome = (msg: unknown): void => {
    const m = msg as CdpMessage;

    // Blind mode = total Chrome→agent blackout (events AND responses).
    if (opts.blind.current() !== null) {
      return;
    }

    if (typeof m.id === "number") {
      // Response: route back to the owning socket only.
      const owner = pending.get(m.id);
      if (owner === undefined) {
        // Daemon-internal CdpClient response (low id, never registered in pending).
        // Drop — never goes to any agent socket.
        return;
      }
      pending.delete(m.id);

      // Cross-epoch response: belongs to a request sent before the last blind cycle.
      // The reconnect-leak case described in the bug report.
      if (owner.epoch !== epoch) {
        return;
      }

      if (owner.ws.readyState !== WebSocket.OPEN) {
        // Owning socket has gone away.
        return;
      }

      // Rewrite the id back to what the agent originally sent.
      const reply: CdpMessage = { ...m, id: owner.originalId };
      owner.ws.send(JSON.stringify(reply));
    } else {
      // Event (has method/sessionId, no id): broadcast to every open socket.
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(m));
        }
      }
    }
  };

  // Register the single outbound listener once for the lifetime of this proxy.
  opts.transport.on("message", onChrome);

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

    ws.on("close", () => {
      sockets.delete(ws);
      // Clean up all pending entries owned by this socket.
      for (const [proxyId, entry] of pending) {
        if (entry.ws === ws) {
          pending.delete(proxyId);
        }
      }
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString("utf8")) as CdpMessage;
        const blindOn = opts.blind.current() !== null;
        const method = msg.method ?? "";

        // Blind = everything blocked. Non-blind: check method allowlist.
        if (blindOn || (method !== "" && !isMethodAllowed(method, blindOn))) {
          if (typeof msg.id === "number") {
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32603, message: "cdp_method_blocked" } }));
          }
          return;
        }

        if (typeof msg.id === "number") {
          // Allocate a proxy id, record ownership, forward with rewritten id.
          const proxyId = nextProxyId++;
          pending.set(proxyId, { ws, originalId: msg.id, epoch });
          opts.transport.send({ ...msg, id: proxyId });
        } else {
          // No numeric id (notification or edge-case): forward as-is.
          opts.transport.send(msg);
        }
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
      // Bump epoch so any responses already in-flight for the current epoch
      // are treated as stale after reconnect.
      epoch++;
      // Clear all pending ownership — in-flight ownership is void after sever.
      pending.clear();
      // Force-close all agent sockets.
      for (const ws of sockets) {
        try { ws.close(1000, "blind_mode_active"); } catch { /* best-effort */ }
        try { ws.terminate(); } catch { /* force-kill if close hangs */ }
      }
      sockets.clear();
    },
    close: () => {
      opts.transport.removeListener("message", onChrome);
      // Terminate all active agent connections before closing the HTTP server
      // so the event loop is not kept alive by open WebSocket handles.
      for (const ws of sockets) {
        try { ws.terminate(); } catch { /* best-effort */ }
      }
      sockets.clear();
      pending.clear();
      wss.close();
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
