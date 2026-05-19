// src/daemon/approvals/ui-server.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShuttleError } from "../../shared/errors.js";
import type { DaemonServer } from "../server.js";
import type { ApprovalStore } from "./store.js";

const HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "ui.html",
);

export function registerUiRoutes(server: DaemonServer, store: ApprovalStore): void {
  server.addRouteRaw("GET", /^\/ui\/approve$/, async (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await readFile(HTML_PATH, "utf8"));
  });

  server.addRouteRaw("GET", /^\/ui\/approvals\/[^/]+$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/approvals\/([^/]+)$/);
    if (m === null) throw new ShuttleError("bad_request", "Bad UI url.");
    const id = m[1] as string;
    const token = url.searchParams.get("token");
    const grant = store.get(id);
    if (grant === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
    if (grant.ui_token !== token) throw new ShuttleError("ui_token_mismatch", "Invalid UI token.");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: grant.id,
      action: grant.action,
      ref: grant.ref,
      planned_ref: grant.planned_ref ?? null,
      environment: grant.environment,
      destination_domain: grant.destination_domain,
      target_id: grant.target_id,
      field_fingerprint: grant.field_fingerprint,
      template_id: grant.template_id,
      template_params: grant.template_params,
      template_binary_path: grant.template_binary_path ?? null,
      template_binary_sha256: grant.template_binary_sha256 ?? null,
      allowed_domains: grant.allowed_domains ?? null,
      allowed_actions: grant.allowed_actions ?? null,
      page_title: grant.page_title ?? null,
      page_url_host: grant.page_url_host ?? null,
      status: grant.status,
      expires_at: grant.expires_at,
    }));
  });

  server.addRouteRaw("POST", /^\/ui\/approvals\/[^/]+\/(approve|deny)$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/approvals\/([^/]+)\/(approve|deny)$/);
    if (m === null) throw new ShuttleError("bad_request", "Bad UI request.");
    const id = m[1] as string;
    const action = m[2] as "approve" | "deny";
    const token = url.searchParams.get("token");
    const grant = store.get(id);
    if (grant === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
    if (grant.ui_token !== token) throw new ShuttleError("ui_token_mismatch", "Invalid UI token.");
    if (action === "approve") store.approve(id);
    else store.deny(id);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, status: action === "approve" ? "granted" : "denied" }));
  });
}
