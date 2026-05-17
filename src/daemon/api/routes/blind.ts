import { ShuttleError } from "../../../shared/errors.js";
import { blankAllPages, disableObservationDomains } from "../../chrome/internal-ops.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";

interface StartBody { domain?: string; reason?: string; }
interface EndBody { approval_id?: string; wait_for_approval?: boolean; }

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
    const b = (raw ?? {}) as EndBody;
    const { approval_id, wait_for_approval } = b;
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
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        force: true,
        ...(approval_id !== undefined ? { approvalIdFromClient: approval_id } : {}),
        ...(wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Approval granted: navigate every visible page to about:blank so any
      // secret on screen is removed BEFORE observation can resume.
      // Fail closed: if blanking fails, the ShuttleError propagates and
      // services.blind.end() is never reached — blind mode stays active.
      if (services.cdp !== null) {
        await blankAllPages(services.cdp);
      }

      const result = services.blind.end();
      await writeDaemonAudit({ action: "blind_end", ok: true, domain: blindDomain });
      return result;
    } catch (err) {
      await writeDaemonAudit({
        action: "blind_end",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
      });
      throw err;
    }
  });
}
