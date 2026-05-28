// src/daemon/approvals/session-ui-server.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { ShuttleError, errorToJson } from "../../shared/errors.js";
import type { DaemonServer } from "../server.js";
import type { SessionStore } from "./session-store.js";

const HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "session-ui.html",
);

/**
 * Register the human-facing session approval UI routes:
 *   - GET  /ui/session?id=&token=          → HTML approval page (this task, G1)
 *   - GET  /ui/sessions/:id?token=         → JSON session data  (G2)
 *   - POST /ui/sessions/:id/approve|deny?token=  → JSON action  (G2)
 *
 * Register BEFORE the JSON sub-routes so the regex for /ui/session matches
 * first. (In practice the JSON routes match /ui/sessions/:id — note the
 * plural — so there's no real conflict, but order is explicit for clarity.)
 */
export function registerSessionUiRoutes(server: DaemonServer, sessionStore: SessionStore): void {
  server.addRouteRaw("GET", /^\/ui\/session(?:\?.*)?$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const id = url.searchParams.get("id") ?? "";
    const token = url.searchParams.get("token") ?? "";
    if (id.length === 0 || token.length === 0) {
      writeError(res, 400, new ShuttleError("bad_request", "Missing id or token."));
      return;
    }
    const grant = sessionStore.get(id);
    if (grant === undefined) {
      writeError(res, 404, new ShuttleError("session_not_found", "Unknown session id."));
      return;
    }
    if (!tokensMatch(grant.ui_token, token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    const template = await readFile(HTML_PATH, "utf8");
    const safePattern = JSON.stringify({
      actions: grant.actions,
      ref_glob: grant.ref_glob,
      destination_domains: grant.destination_domains,
      template_ids: grant.template_ids,
      allowed_actions: grant.allowed_actions,
      required_params: grant.required_params,
      ttl_ms: grant.ttl_ms,
      max_uses: grant.max_uses,
    }, null, 2);
    const requiredParamsLine = formatRequiredParamsLine(grant.required_params);
    const html = template
      .replaceAll("__SESSION_ID__", htmlEscape(grant.id))
      .replaceAll("__UI_TOKEN__", htmlEscape(grant.ui_token))
      .replaceAll("__TTL_MINUTES__", String(Math.round(grant.ttl_ms / 60_000)))
      .replaceAll("__PATTERN_JSON__", htmlEscape(safePattern))
      .replaceAll("__REQUIRED_PARAMS_LINE__", requiredParamsLine);
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    // Real CSP HTTP header — the <meta http-equiv> inside the HTML is widely
    // ignored for `frame-ancestors` enforcement; only the HTTP header counts.
    // Inline script is permitted via 'unsafe-inline' for v0.2.0; a nonce-based
    // CSP is a Plan 4b enhancement once the stable-shell UI lands.
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'",
    );
    res.end(html);
  });

  // GET /ui/sessions/:id?token=<ui_token>
  server.addRouteRaw("GET", /^\/ui\/sessions\/[^/]+$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/sessions\/([^/]+)$/);
    if (m === null) {
      writeError(res, 400, new ShuttleError("bad_request", "Bad URL."));
      return;
    }
    const id = m[1] as string;
    const token = url.searchParams.get("token") ?? "";
    const grant = sessionStore.get(id);
    if (grant === undefined) {
      writeError(res, 404, new ShuttleError("session_not_found", "Unknown session id."));
      return;
    }
    if (!tokensMatch(grant.ui_token, token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    setHardeningHeaders(res);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: grant.id,
      status: grant.status,
      actions: grant.actions,
      ref_glob: grant.ref_glob,
      destination_domains: grant.destination_domains,
      ...(grant.template_ids !== undefined ? { template_ids: grant.template_ids } : {}),
      ...(grant.allowed_actions !== undefined ? { allowed_actions: grant.allowed_actions } : {}),
      ttl_ms: grant.ttl_ms,
      ...(grant.max_uses !== undefined ? { max_uses: grant.max_uses } : {}),
      created_at: grant.created_at,
      approved_at: grant.approved_at,
      expires_at: grant.expires_at,
    }));
  });

  // POST /ui/sessions/:id/approve?token=<ui_token>
  // POST /ui/sessions/:id/deny?token=<ui_token>
  server.addRouteRaw("POST", /^\/ui\/sessions\/[^/]+\/(approve|deny)$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/sessions\/([^/]+)\/(approve|deny)$/);
    if (m === null) {
      writeError(res, 400, new ShuttleError("bad_request", "Bad URL."));
      return;
    }
    const id = m[1] as string;
    const verb = m[2] as "approve" | "deny";
    const token = url.searchParams.get("token") ?? "";
    const grant = sessionStore.get(id);
    if (grant === undefined) {
      writeError(res, 404, new ShuttleError("session_not_found", "Unknown session id."));
      return;
    }
    if (!tokensMatch(grant.ui_token, token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    try {
      if (verb === "approve") sessionStore.approve(id);
      else sessionStore.deny(id);
    } catch (e) {
      // session_not_pending → 409 conflict.
      if (e instanceof ShuttleError && e.code === "session_not_pending") {
        writeError(res, 409, e);
        return;
      }
      writeError(res, 400, e);
      return;
    }
    setHardeningHeaders(res);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, status: verb === "approve" ? "granted" : "denied" }));
  });
}

/**
 * Render a human-readable `Required params:` row for the session approval UI.
 * Returns a fully-escaped <p> element when non-empty, or an empty string when
 * the pattern has no `required_params` constraint. The empty-string path keeps
 * the template clean for the common case (no param constraints).
 */
function formatRequiredParamsLine(rp: Record<string, string> | undefined): string {
  if (rp === undefined) return "";
  const entries = Object.entries(rp);
  if (entries.length === 0) return "";
  const formatted = entries
    .map(([k, v]) => `${htmlEscape(k)}=${htmlEscape(v)}`)
    .join(", ");
  return `<p class="required-params"><strong>Required params:</strong> ${formatted}</p>`;
}

function htmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Set Cache-Control, Referrer-Policy, and X-Content-Type-Options on every
 * token-bearing UI response (HTML or JSON). Token-bearing means the request
 * URL carries `?token=<ui_token>`; browser caches or referrers leaking that
 * token would let a different process or page replay the action.
 */
function setHardeningHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
}

function tokensMatch(expected: string, actual: string): boolean {
  const e = Buffer.from(expected);
  const a = Buffer.from(actual);
  if (a.byteLength !== e.byteLength) return false;
  return timingSafeEqual(a, e);
}

function writeError(res: import("node:http").ServerResponse, status: number, err: unknown): void {
  if (res.writableEnded) return;
  setHardeningHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(errorToJson(err)));
}
