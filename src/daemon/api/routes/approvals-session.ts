import { ShuttleError } from "../../../shared/errors.js";
import { openUrl } from "../../approvals/open-url.js";
import {
  assertSessionPatternValid,
  type SessionAction,
  type SessionPattern,
} from "../../approvals/session.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { asObject, optBool, reqString } from "../validate.js";

const POLL_INTERVAL_MS = 200;

export function registerApprovalsSessionRoutes(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/approvals/session", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const pattern = parseSessionPatternFromBody(o);
    const waitForApproval = optBool(o, "wait_for_approval");
    assertSessionPatternValid(pattern); // belt-and-braces; store.create does it too
    const grant = services.sessionStore.create(pattern);
    // Open the HTML approval page (not the JSON sub-route). The HTML page
    // POSTs to /ui/sessions/:id/approve|deny on button click.
    openUrl(
      `http://127.0.0.1:${daemonPortRef()}/ui/session?id=${grant.id}&token=${grant.ui_token}`,
    );
    if (waitForApproval === false) {
      return { session_id: grant.id, status: "pending", expires_at: grant.expires_at };
    }
    // Poll until terminal status or PENDING window elapses.
    while (true) {
      const g = services.sessionStore.get(grant.id);
      if (g === undefined) throw new ShuttleError("session_not_found", "Session vanished.");
      if (g.status === "granted") {
        return { session_id: g.id, status: "granted", expires_at: g.expires_at };
      }
      if (g.status === "denied") throw new ShuttleError("approval_denied", "Session denied.");
      if (g.status === "expired") {
        throw new ShuttleError("approval_timeout", "Timed out waiting for session approval.");
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  });

  server.addRoute("GET", "/v1/approvals/sessions", () => {
    services.lock.requireKey();
    return {
      sessions: services.sessionStore.list().map((g) => ({
        id: g.id,
        status: g.status,
        actions: g.actions,
        ref_glob: g.ref_glob,
        destination_domains: g.destination_domains,
        ...(g.template_ids !== undefined ? { template_ids: g.template_ids } : {}),
        ...(g.allowed_actions !== undefined ? { allowed_actions: g.allowed_actions } : {}),
        ttl_ms: g.ttl_ms,
        ...(g.max_uses !== undefined ? { max_uses: g.max_uses } : {}),
        created_at: g.created_at,
        approved_at: g.approved_at,
        expires_at: g.expires_at,
        uses: g.uses,
      })),
    };
  });

  server.addRoute("POST", "/v1/approvals/sessions/revoke", (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const sessionId = reqString(o, "session_id");
    services.sessionStore.revoke(sessionId); // throws session_not_found
    return { revoked: true, session_id: sessionId };
  });
}

function parseSessionPatternFromBody(o: Record<string, unknown>): SessionPattern {
  if (o.pattern === undefined) {
    throw new ShuttleError("missing_param", "pattern is required.");
  }
  if (o.pattern === null || typeof o.pattern !== "object" || Array.isArray(o.pattern)) {
    throw new ShuttleError("bad_request", "pattern must be an object.");
  }
  const p = o.pattern as Record<string, unknown>;
  if (!Array.isArray(p.actions)) {
    throw new ShuttleError("bad_request", "pattern.actions must be an array.");
  }
  for (const a of p.actions) {
    if (typeof a !== "string") {
      throw new ShuttleError("bad_request", "pattern.actions entries must be strings.");
    }
  }
  if (typeof p.ref_glob !== "string") {
    throw new ShuttleError("bad_request", "pattern.ref_glob must be a string.");
  }
  if (!Array.isArray(p.destination_domains)) {
    throw new ShuttleError("bad_request", "pattern.destination_domains must be an array.");
  }
  for (const d of p.destination_domains) {
    if (typeof d !== "string") {
      throw new ShuttleError("bad_request", "pattern.destination_domains entries must be strings.");
    }
  }
  if (p.template_ids !== undefined) {
    if (!Array.isArray(p.template_ids)) {
      throw new ShuttleError("bad_request", "pattern.template_ids must be an array.");
    }
    for (const t of p.template_ids) {
      if (typeof t !== "string") {
        throw new ShuttleError("bad_request", "pattern.template_ids entries must be strings.");
      }
    }
  }
  if (p.allowed_actions !== undefined) {
    if (!Array.isArray(p.allowed_actions)) {
      throw new ShuttleError("bad_request", "pattern.allowed_actions must be an array.");
    }
    for (const a of p.allowed_actions) {
      if (typeof a !== "string") {
        throw new ShuttleError("bad_request", "pattern.allowed_actions entries must be strings.");
      }
    }
  }
  if (typeof p.ttl_ms !== "number") {
    throw new ShuttleError("bad_request", "pattern.ttl_ms must be a number.");
  }
  if (p.max_uses !== undefined && (typeof p.max_uses !== "number" || !Number.isInteger(p.max_uses))) {
    throw new ShuttleError("bad_request", "pattern.max_uses must be an integer.");
  }
  return {
    actions: p.actions as SessionAction[], // assertSessionPatternValid will validate the SessionAction enum
    ref_glob: p.ref_glob,
    destination_domains: p.destination_domains as string[],
    ...(p.template_ids !== undefined ? { template_ids: p.template_ids as string[] } : {}),
    ...(p.allowed_actions !== undefined ? { allowed_actions: p.allowed_actions as string[] } : {}),
    ttl_ms: p.ttl_ms,
    ...(p.max_uses !== undefined ? { max_uses: p.max_uses as number } : {}),
  };
}
