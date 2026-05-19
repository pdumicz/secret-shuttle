import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { domainMatches } from "../../../policy/domain-policy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { asObject, reqString } from "../validate.js";
import { disableObservationDomains } from "../../chrome/internal-ops.js";
import { enforceDomain } from "./secrets.js";
import { autoResumeBlind } from "../../blind-auto-resume.js";

interface InjectSubmitBody {
  ref: string;
  domain?: string;
  field_handle: string;
  submit_handle: string;
  success_text: string;
  success_timeout_ms?: number;
  approval_id?: string;
  wait_for_approval?: boolean;
}

const SUCCESS_TIMEOUT_DEFAULT_MS = 15_000;
const SUCCESS_TIMEOUT_CAP_MS = 60_000;

export function registerInjectSubmit(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/secrets/inject-submit", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const ref = reqString(o, "ref");
    const fieldHandleLabel = reqString(o, "field_handle");
    const submitHandleLabel = reqString(o, "submit_handle");
    const successText = reqString(o, "success_text");
    const b = raw as InjectSubmitBody;
    let blindStarted = false;
    try {
      if (services.browser === null) {
        throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      }
      const browser = services.browser;
      const secret = await services.vault.getSecret(ref);
      assertSecretActionAllowed(secret, "inject_submit");

      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is already active; run `secret-shuttle blind end` before inject-submit.",
        );
      }

      const fieldHandle = services.handles.get(fieldHandleLabel);
      if (fieldHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${fieldHandleLabel}.`);
      const submitHandle = services.handles.get(submitHandleLabel);
      if (submitHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${submitHandleLabel}.`);

      // Revalidate while observation is still safe (§3.4).
      await browser.revalidateHandle(fieldHandle);
      await browser.revalidateHandle(submitHandle);
      if (fieldHandle.element_kind !== "field") {
        throw new ShuttleError("handle_kind_mismatch", "field_handle must be a field.");
      }
      if (submitHandle.element_kind !== "button" && submitHandle.element_kind !== "link") {
        throw new ShuttleError("handle_kind_mismatch", "submit_handle must be a button or link.");
      }
      // Fail-closed: the daemon injects into the field handle's target then clicks
      // the submit handle. The approved binding records ONLY the field target/
      // domain, so the submit handle MUST be on the same page/target and domain —
      // otherwise the click could land on a different tab/site than approved.
      if (submitHandle.target_id !== fieldHandle.target_id || submitHandle.domain !== fieldHandle.domain) {
        throw new ShuttleError(
          "handle_target_mismatch",
          "submit_handle must be on the same page/target and domain as field_handle.",
        );
      }

      const domain = fieldHandle.domain;
      if (b.domain !== undefined && !domainMatches(domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Field handle domain ${domain} != ${b.domain}.`);
      }
      enforceDomain(domain, secret.allowed_domains, "inject-submit");

      let successTimeoutMs = SUCCESS_TIMEOUT_DEFAULT_MS;
      const tms = o["success_timeout_ms"];
      if (typeof tms === "number" && Number.isFinite(tms)) {
        successTimeoutMs = Math.min(Math.max(1_000, Math.floor(tms)), SUCCESS_TIMEOUT_CAP_MS);
      }

      const binding: ApprovalBinding = {
        action: "inject_submit",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: domain,
        target_id: fieldHandle.target_id,
        field_fingerprint: fieldHandle.handle_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: secret.allowed_domains,
        submit_fingerprint: submitHandle.handle_fingerprint,
        success_condition: successText,
        auto_resume: true,
        field_handle_label: fieldHandle.label,
        submit_handle_label: submitHandle.label,
        ...(fieldHandle.page_title !== "" ? { page_title: fieldHandle.page_title } : {}),
        ...(fieldHandle.page_url_host !== "" ? { page_url_host: fieldHandle.page_url_host } : {}),
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        force: true,
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Daemon OWNS the blind window: black out the agent BEFORE the value can
      // ever reach the page (mirrors /v1/secrets/inject).
      services.blind.start(domain, "inject_submit");
      blindStarted = true;
      if (services.cdp !== null) {
        await disableObservationDomains(services.cdp).catch(() => undefined);
      }
      services.cdpProxy?.severAgentConnections();

      // Re-revalidate post-approval, pre-write. Failure here = nothing written →
      // safe to end blind and rethrow (mirrors current inject pre-write path).
      try {
        await browser.revalidateHandle(fieldHandle);
        await browser.revalidateHandle(submitHandle);
      } catch (preWriteErr) {
        services.blind.end();
        throw preWriteErr;
      }

      // From here the secret is on the page. A failure (incl. a HANG — see
      // withDeadline) MUST NOT auto-resume: blind stays ACTIVE; respond
      // fail-closed (submitted:"unknown").
      try {
        // I3 (Task-6 review carry-forward): injectIntoBackendNode/clickBackendNode
        // use RAW cdp.send (no internal timeout). A hung CDP frame would never
        // throw nor resolve → this route would hang forever and the post-write
        // catch could never fire. Wrap the secret-bearing sequence in an overall
        // deadline so a hang becomes a caught failure → fail-closed (blind stays
        // active). Tunable via env for tests; generous default for real use.
        const injectClickDeadlineMs = Number(process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS) || 30_000;
        await withDeadline(
          (async () => {
            await browser.injectIntoBackendNode(
              { target_id: fieldHandle.target_id, backend_node_id: fieldHandle.backend_node_id },
              secret.value,
            );
            await browser.clickBackendNode({
              target_id: submitHandle.target_id,
              backend_node_id: submitHandle.backend_node_id,
            });
          })(),
          injectClickDeadlineMs,
          "inject_click_timeout",
        );
      } catch {
        await services.vault.markUsed(secret.ref).catch(() => undefined);
        await writeDaemonAudit({
          action: "inject_submit", ok: false, ref: secret.ref, environment: secret.environment,
          domain, submitted: "unknown", blind_mode: true,
        });
        return {
          submitted: "unknown", secret_ref: secret.ref, domain,
          blind_mode: true, next: "manual_recovery_required", value_visible_to_agent: false,
        };
      }

      let successObserved = false;
      try {
        successObserved = await browser.observeText(domain, successText, successTimeoutMs);
      } catch {
        successObserved = false;
      }
      let proofPassed = false;
      if (successObserved) {
        try {
          proofPassed = (await browser.proveAbsence(secret.value)).passed;
        } catch {
          proofPassed = false;
        }
      }
      await services.vault.markUsed(secret.ref);

      if (successObserved && proofPassed) {
        // T7-M1 (Task-7 review carry-forward): autoResumeBlind throws BEFORE it
        // ends blind if its preconditions aren't met, and writeDaemonAudit
        // swallows disk errors (so an audit-write failure is NOT a signal). If
        // autoResumeBlind throws for ANY reason, blind is still ACTIVE — treat
        // it as "not provably safe": fall through to the fail-closed body
        // instead of 500ing via the outer catch.
        try {
          await autoResumeBlind(services, {
            op: "inject_submit", domain, success_signal: "text_matched", absence_proof: "passed",
          });
          await writeDaemonAudit({
            action: "inject_submit", ok: true, ref: secret.ref, environment: secret.environment,
            domain, submitted: true, success_signal: "text_matched", absence_proof: "passed", blind_mode: false,
          });
          return {
            submitted: true, secret_ref: secret.ref, domain,
            success_signal: "text_matched", absence_proof: "passed",
            blind_mode: false, value_visible_to_agent: false,
          };
        } catch {
          // autoResumeBlind refused/failed → blind remains active → fail-closed.
        }
      }

      await writeDaemonAudit({
        action: "inject_submit", ok: true, ref: secret.ref, environment: secret.environment,
        domain, submitted: "unknown", blind_mode: true,
      });
      return {
        submitted: "unknown", secret_ref: secret.ref, domain,
        blind_mode: true, next: "manual_recovery_required", value_visible_to_agent: false,
      };
    } catch (err) {
      // Errors before blind.start (handle/kind/domain/approval) → blind never
      // started. The pre-write path already ended blind & is rethrowing here.
      void blindStarted;
      await writeDaemonAudit({
        action: "inject_submit",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(ref !== undefined ? { ref } : {}),
      });
      throw err;
    }
  });
}

// I3 carry-forward helper. Races `p` against a deadline; clears its timer on
// settle (no leaked 30s timer per successful call). If `p` hangs forever it
// stays orphaned but the route fails closed instead of hanging — the route's
// post-write catch maps the rejection to submitted:"unknown" / blind stays
// active. Defined at module scope (not per-request).
function withDeadline<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShuttleError(code, `Operation exceeded ${ms}ms.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
