// src/daemon/approvals/ui-server.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShuttleError } from "../../shared/errors.js";
import { readBoundedJson } from "../helpers/bounded-json.js";
import type { DaemonServer } from "../server.js";
import type { BootstrapStore } from "../bootstrap/store.js";
import type { ApprovalStore } from "./store.js";
import { inferSessionPatternFromPlan } from "./infer-session-pattern.js";
import type { SessionStore } from "./session-store.js";
import type { SessionPattern } from "./session.js";

const HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "ui.html",
);

/**
 * Dependencies the approvals UI server needs. Bundled as an object so callers
 * can extend it without rippling positional-arg edits through the codebase.
 *
 * Burst 5 §2b Task 2b.4: the POST /ui/approvals/:id/approve route now reads
 * an optional session-on-approve body and mints session grants derived from
 * the originating bootstrap batch's plan. That requires SessionStore and
 * BootstrapStore in addition to the original ApprovalStore.
 */
export interface ApprovalsUiDeps {
  approvals: ApprovalStore;
  sessions: SessionStore;
  bootstrap: BootstrapStore;
}

export function registerUiRoutes(server: DaemonServer, deps: ApprovalsUiDeps): void {
  server.addRouteRaw("GET", /^\/ui\/approve$/, async (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    // frame-ancestors 'self' lets the hub iframe embed this page.
    // The per-URL ui_token remains the operational security boundary.
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    res.end(await readFile(HTML_PATH, "utf8"));
  });

  server.addRouteRaw("GET", /^\/ui\/approvals\/[^/]+$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/approvals\/([^/]+)$/);
    if (m === null) throw new ShuttleError("bad_request", "Bad UI url.");
    const id = m[1] as string;
    const token = url.searchParams.get("token");
    const grant = deps.approvals.get(id);
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
      submit_fingerprint: grant.submit_fingerprint ?? null,
      success_condition: grant.success_condition ?? null,
      field_handle_label: grant.field_handle_label ?? null,
      submit_handle_label: grant.submit_handle_label ?? null,
      reveal_fingerprint: grant.reveal_fingerprint ?? null,
      hide_fingerprint: grant.hide_fingerprint ?? null,
      container_fingerprint: grant.container_fingerprint ?? null,
      capture_mode: grant.capture_mode ?? null,
      reveal_handle_label: grant.reveal_handle_label ?? null,
      hide_handle_label: grant.hide_handle_label ?? null,
      container_handle_label: grant.container_handle_label ?? null,
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
    const grant = deps.approvals.get(id);
    if (grant === undefined) throw new ShuttleError("approval_not_found", "Unknown approval id.");
    if (grant.ui_token !== token) throw new ShuttleError("ui_token_mismatch", "Invalid UI token.");

    if (action === "deny") {
      deps.approvals.deny(id);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, status: "denied" }));
      return;
    }

    // ── approve path with optional session-on-approve body ─────────────────
    // Burst 5 §2b Task 2b.4. allowEmpty:true so a legacy approve POST with
    // no body still works (the existing UI form sends an empty POST when the
    // checkbox is unchecked).
    const sessionBody = (await readBoundedJson(req, 1024, { allowEmpty: true })) as {
      session?: { ttl_minutes?: number };
    };

    let sessionPlan: { ttl_ms: number; patterns: SessionPattern[] } | null = null;
    const sessionRequest = sessionBody.session;
    if (sessionRequest !== undefined && sessionRequest !== null && typeof sessionRequest === "object") {
      const ttl_minutes = sessionRequest.ttl_minutes;
      if (typeof ttl_minutes !== "number" || ![5, 15, 30, 60].includes(ttl_minutes)) {
        throw new ShuttleError(
          "bad_request",
          `ttl_minutes must be one of 5, 15, 30, 60; got ${String(ttl_minutes)}.`,
        );
      }
      const ttl_ms = ttl_minutes * 60 * 1000;

      // grant.template_params.batch_id (set by the bootstrap route at
      // src/daemon/api/routes/bootstrap.ts:107) — NOT a top-level grant.batch_id.
      // Only bootstrap-action grants carry a batch_id; other actions silently
      // skip session minting.
      const batchId = grant.template_params?.["batch_id"];
      if (typeof batchId === "string" && batchId.length > 0) {
        const batch = await deps.bootstrap.get(batchId);
        if (batch !== null) {
          const { patterns } = inferSessionPatternFromPlan(batch.plan, ttl_ms);
          sessionPlan = { ttl_ms, patterns };
        }
      }
    }

    // ───── PHASE A: precreate sessions in PENDING state BEFORE approval. ─────
    // Session creation here can throw (validator rejects pattern shape, etc.).
    // If it throws, we have NOT yet flipped the main grant to granted, so the
    // user sees a clean error and the approval can be retried fresh.
    const precreatedIds: string[] = [];
    if (sessionPlan !== null) {
      try {
        for (const pattern of sessionPlan.patterns) {
          const sess = deps.sessions.createForOwner(pattern, grant.owner_agent_id);
          precreatedIds.push(sess.id);
        }
      } catch (err) {
        // Roll back what we precreated. SessionStore has revoke(id), NOT
        // delete (src/daemon/approvals/session-store.ts:84). Revoke is fine:
        // these grants were never approved, never reachable by other actors.
        for (const sid of precreatedIds) {
          try { deps.sessions.revoke(sid); } catch { /* best-effort */ }
        }
        throw err;
      }
    }

    // ───── PHASE B: approve the main grant. Irreversible from here. ─────
    deps.approvals.approve(id);

    // ───── PHASE C: flip precreated sessions to granted. ─────
    // If approve() throws here (extremely unlikely — a non-pending session
    // would mean concurrent revocation), best-effort: log and continue. The
    // main approval has already committed; we can't un-do that. A missing
    // session means the next matching op will pop a fresh approval, which is
    // correct behavior.
    for (const sid of precreatedIds) {
      try { deps.sessions.approve(sid); } catch { /* see comment above */ }
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, status: "granted" }));
  });
}
