import { ShuttleError } from "../../../shared/errors.js";
import { blankAllPages, disableObservationDomains } from "../../chrome/internal-ops.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import { asObject, optApprovalIds } from "../validate.js";

interface StartBody { domain?: string; reason?: string; }
interface EndBody { approval_ids?: string[]; wait_for_approval?: boolean; session_id?: string; }

export function registerBlind(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/blind/start", async (_req, raw) => {
    const b = (raw ?? {}) as StartBody;
    try {
      if (typeof b.domain !== "string" || typeof b.reason !== "string") {
        throw new ShuttleError("bad_request", "domain and reason are required.");
      }
      const state = services.blind.start(b.domain, b.reason);
      // Best-effort: tell Chrome to stop emitting observation domains on all page
      // targets so pre-enabled subscriptions (Runtime.consoleAPICalled, etc.) stop
      // flowing even for events registered before this blind-start call.
      if (services.cdp !== null) {
        await disableObservationDomains(services.cdp).catch(() => undefined);
      }
      // Sever all agent WebSocket connections so any pre-armed requests
      // (e.g. Runtime.evaluate with awaitPromise:true) cannot deliver responses.
      services.cdpProxy?.severAgentConnections();
      await writeDaemonAudit({ action: "blind_start", ok: true, domain: state.domain });
      return {
        blind_mode: true,
        domain: state.domain,
        reason: state.reason,
        started_at: state.started_at,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "blind_start",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(typeof b.domain === "string" ? { domain: b.domain } : {}),
      });
      throw err;
    }
  });
  server.addRoute("POST", "/v1/blind/end", async (_req, raw) => {
    const o = asObject(raw);
    const approvalIds = optApprovalIds(o);
    const b = (raw ?? {}) as EndBody;
    const { wait_for_approval, session_id } = b;
    // Hoisted OUTSIDE the try so the catch-block audit can carry session_id
    // when applicable. blind_end is NOT a SessionAction — re-revealing the
    // page after a blind mask is a destructive privacy boundary — so the
    // matcher refuses and requireApproval falls back to single-use;
    // grant.session_id is therefore always undefined and the conditional
    // spread evaluates to nothing. We still wire the spread to preserve a
    // single audit shape across all routes.
    let grant: ApprovalGrant | undefined;
    try {
      // If blind mode is not active, this is an idempotent no-op — no approval needed.
      const activeBlind = services.blind.current();
      if (activeBlind === null) {
        const result = services.blind.end();
        await writeDaemonAudit({ action: "blind_end", ok: true });
        return result;
      }

      const blindDomain = activeBlind.domain;

      // Blind is active — require a human to attest the screen is safe.
      const binding: ApprovalBinding = {
        action: "blind_end",
        ref: null,
        environment: "blind",
        destination_domain: blindDomain,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
      };
      const grants = await requireApprovals({
        store: services.approvals,
        bindings: [binding],
        daemonPort: daemonPortRef(),
        force: true,
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        ...(session_id !== undefined ? { sessionId: session_id } : {}),
        ...(approvalIds !== undefined ? { approvalIdsFromClient: approvalIds } : {}),
        ...(wait_for_approval === false ? { waitMs: 0 } : {}),
      });
      grant = grants[0]!

      // Approval granted: navigate every visible page to about:blank so any
      // secret on screen is removed BEFORE observation can resume.
      // Fail closed: if blanking fails, the ShuttleError propagates and
      // services.blind.end() is never reached — blind mode stays active.
      if (services.cdp !== null) {
        await blankAllPages(services.cdp);
      }

      const result = services.blind.end();
      await writeDaemonAudit({
        action: "blind_end",
        ok: true,
        domain: blindDomain,
        ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      return result;
    } catch (err) {
      await writeDaemonAudit({
        action: "blind_end",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      throw err;
    }
  });
}
