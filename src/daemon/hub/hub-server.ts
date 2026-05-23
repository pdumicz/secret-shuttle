// src/daemon/hub/hub-server.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShuttleError, errorToJson } from "../../shared/errors.js";
import type { DaemonServer } from "../server.js";
import type { HubBroker } from "./hub-broker.js";

const HUB_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "hub-ui.html",
);

/**
 * Register the persistent hub-tab routes:
 *   GET  /ui/hub?token=H          → HTML shell (this task, B1)
 *   GET  /ui/hub/stream?token=H   → SSE feed (B2)
 *   POST /ui/hub/done?token=H     → operation completion signal (B3)
 *
 * All three routes use addRouteRaw (per-URL-token auth bypasses bearer).
 * Spec: docs/superpowers/specs/2026-05-23-plan4b-tab-reuse-design.md
 * Component 2.
 */
export function registerHubRoutes(server: DaemonServer, broker: HubBroker): void {
  server.addRouteRaw("GET", /^\/ui\/hub$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const token = url.searchParams.get("token");
    if (token === null || token.length === 0) {
      writeError(res, 400, new ShuttleError("bad_request", "Missing token."));
      return;
    }
    if (!broker.tokenMatches(token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    const html = await readFile(HUB_HTML_PATH, "utf8");
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    setHardeningHeaders(res);
    // CSP allows the iframe (frame-src 'self') and the SSE connect
    // (connect-src 'self'). frame-ancestors 'none' on the HUB ITSELF
    // (a hostile page must not embed the hub); the operation pages
    // relax this to 'self' so the hub can iframe them.
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-src 'self'; child-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    res.end(html);
  });

  server.addRouteRaw("GET", /^\/ui\/hub\/stream$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const token = url.searchParams.get("token");
    if (token === null || token.length === 0) {
      writeError(res, 400, new ShuttleError("bad_request", "Missing token."));
      return;
    }
    if (!broker.tokenMatches(token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-accel-buffering", "no");
    setHardeningHeaders(res);
    // Flush headers so the client knows the connection is open before
    // any data frame arrives. (Node sends headers on first write/flush.)
    res.flushHeaders?.();

    const sub: import("./hub-broker.js").HubSubscriber = {
      write: (e) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      },
      // Reassigned below to also invoke cleanup().
      close: () => undefined,
    };

    const detach = broker.attach(sub);
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(keepalive);
      detach();
    };
    sub.close = () => {
      if (!res.writableEnded && !res.destroyed) res.end();
      cleanup();
    };

    const keepalive = setInterval(() => {
      if (res.writableEnded || res.destroyed) { cleanup(); return; }
      res.write(": ping\n\n");
    }, 25_000);
    // Stop the keepalive from blocking node from exiting under test.
    keepalive.unref?.();

    req.on("close", cleanup);
  });
}

function setHardeningHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
}

function writeError(res: import("node:http").ServerResponse, status: number, err: unknown): void {
  if (res.writableEnded) return;
  setHardeningHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(errorToJson(err)));
}
