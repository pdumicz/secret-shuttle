import { ShuttleError } from "../../../shared/errors.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import type { ResolvedSecret } from "../../../vault/types.js";
import { domainMatches } from "../../../policy/domain-policy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { asObject, optApprovalIds, reqString } from "../validate.js";
import { blankAllPages, disableObservationDomains } from "../../chrome/internal-ops.js";
import { enforceDomain } from "./secrets.js";
import { autoResumeBlind } from "../../blind-auto-resume.js";

interface InjectSubmitBody {
  ref: string;
  domain?: string;
  field_handle: string;
  submit_handle: string;
  success_text: string;
  success_timeout_ms?: number;
  approval_ids?: string[];
  wait_for_approval?: boolean;
  session_id?: string;
}

const SUCCESS_TIMEOUT_DEFAULT_MS = 15_000;
const SUCCESS_TIMEOUT_CAP_MS = 60_000;

export function registerInjectSubmit(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/secrets/inject-submit", async (_req, raw) => {
    services.lock.assertUnlocked();
    const o = asObject(raw);
    const ref = reqString(o, "ref");
    const fieldHandleLabel = reqString(o, "field_handle");
    const submitHandleLabel = reqString(o, "submit_handle");
    const successText = reqString(o, "success_text");
    const approvalIds = optApprovalIds(o);
    const b = raw as InjectSubmitBody;
    let blindStarted = false;
    // Hoisted OUTSIDE the try so a post-mint failure (e.g. pre-write
    // revalidateHandle throws AFTER requireApproval consumed the session)
    // still carries grant.session_id into the failure audit.  Optional-chained
    // at use site because grant remains undefined if requireApproval itself
    // threw (pre-mint failure), in which case no session was consumed and
    // audit MUST NOT carry session_id.
    let grant: ApprovalGrant | undefined;
    // Burst 7 §2 (5q): the resolved plaintext is held in a single SecretValue
    // that feeds BOTH sinks (injectIntoBackendNode + proveAbsence) and is
    // disposed ONCE in the outer finally below. Hoisted OUTSIDE the try so the
    // finally sees it on every exit path (success, throw, successTimeoutMs
    // timeout).
    let resolved: ResolvedSecret | undefined;
    try {
      if (services.browser === null) {
        throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      }
      const browser = services.browser;
      const meta = await services.vault.inspect(ref);
      assertSecretActionAllowed(meta, "inject_submit");

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
      enforceDomain(domain, meta.allowed_domains, "inject-submit");

      let successTimeoutMs = SUCCESS_TIMEOUT_DEFAULT_MS;
      const tms = o["success_timeout_ms"];
      if (typeof tms === "number" && Number.isFinite(tms)) {
        successTimeoutMs = Math.min(Math.max(1_000, Math.floor(tms)), SUCCESS_TIMEOUT_CAP_MS);
      }

      const binding: ApprovalBinding = {
        action: "inject_submit",
        ref: meta.ref,
        environment: meta.environment,
        destination_domain: domain,
        target_id: fieldHandle.target_id,
        field_fingerprint: fieldHandle.handle_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: meta.allowed_domains,
        submit_fingerprint: submitHandle.handle_fingerprint,
        success_condition: successText,
        auto_resume: true,
        field_handle_label: fieldHandle.label,
        submit_handle_label: submitHandle.label,
        ...(fieldHandle.page_title !== "" ? { page_title: fieldHandle.page_title } : {}),
        ...(fieldHandle.page_url_host !== "" ? { page_url_host: fieldHandle.page_url_host } : {}),
      };
      // Single requireApproval call — handles both the initial (no approval_id)
      // and the retry (approval_id supplied) paths.  When session_id is set and
      // the binding matches an inject-submit session pattern (ref +
      // destination_domain), the call mints a used grant from the session and
      // the audits emitted below carry grant.session_id; otherwise the call
      // falls back to the single-use flow and grant.session_id is undefined.
      const grants = await requireApprovals({
        store: services.approvals,
        bindings: [binding],
        daemonPort: daemonPortRef(),
        force: true,
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        ...(b.session_id !== undefined ? { sessionId: b.session_id } : {}),
        ...(approvalIds !== undefined ? { approvalIdsFromClient: approvalIds } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });
      grant = grants[0]!

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

      // Burst 7 §2 (5q): resolve the plaintext ONLY now — after approval, after
      // the pre-write revalidate, immediately before the sink. One SecretValue
      // feeds both injectIntoBackendNode AND proveAbsence below; the outer
      // finally disposes it exactly once.
      resolved = await services.vault.resolveSecret(ref);

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
              resolved.value.bytes().toString("utf8"),
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
        // Post-write failure (thrown inject/click OR the withDeadline timeout):
        // the secret may be on the page from a partial inject, and on the
        // timeout path the orphaned inject/click op may still be RUNNING and
        // could land the secret AFTER we return — racing the human
        // manual-recovery attestation (a TOCTOU against /v1/blind/end). Proactively
        // neutralize the page now with the SAME hardened primitive the human
        // /v1/blind/end uses (blankAllPages → about:blank): any already-written
        // secret is removed, and a later orphaned write/click lands on
        // about:blank / a stale backend node and is inert. Best-effort and
        // bounded (blankAllPages uses raw cdp.send and can itself hang): its
        // failure must NOT change the response — blind STAYS active, the
        // fail-closed 200 is unchanged, and the human /v1/blind/end
        // (requireApproval + its own blankAllPages) remains the authoritative
        // recovery. This is additive defense-in-depth that shrinks the
        // orphan/TOCTOU window; it does NOT end blind or replace manual recovery.
        if (services.cdp !== null) {
          const blankMs = Number(process.env.SECRET_SHUTTLE_BLANK_DEADLINE_MS) || 15_000;
          await withDeadline(blankAllPages(services.cdp), blankMs, "blank_timeout").catch(() => undefined);
        }
        await services.vault.markUsed(meta.ref).catch(() => undefined);
        await writeDaemonAudit({
          action: "inject_submit", ok: false, ref: meta.ref, environment: meta.environment,
          domain, submitted: "unknown", blind_mode: true,
          ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
        });
        return {
          submitted: "unknown", secret_ref: meta.ref, domain,
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
          proofPassed = (await browser.proveAbsence(resolved.value.bytes().toString("utf8"))).passed;
        } catch {
          proofPassed = false;
        }
      }
      await services.vault.markUsed(meta.ref).catch(() => undefined);

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
            action: "inject_submit", ok: true, ref: meta.ref, environment: meta.environment,
            domain, submitted: true, success_signal: "text_matched", absence_proof: "passed", blind_mode: false,
            ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
          });
          return {
            submitted: true, secret_ref: meta.ref, domain,
            success_signal: "text_matched", absence_proof: "passed",
            blind_mode: false, value_visible_to_agent: false,
          };
        } catch {
          // autoResumeBlind refused/failed → blind remains active → fail-closed.
        }
      }

      await writeDaemonAudit({
        action: "inject_submit", ok: true, ref: meta.ref, environment: meta.environment,
        domain, submitted: "unknown", blind_mode: true,
        ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      return {
        submitted: "unknown", secret_ref: meta.ref, domain,
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
        // Optional-chain: grant is undefined if requireApproval itself threw
        // (pre-mint failure — no session consumed → audit MUST NOT carry
        // session_id).  Otherwise grant.session_id is the source session iff
        // the binding matched the session pattern.
        ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      throw err;
    } finally {
      // Burst 7 §2 (5q): scrub the single resolved SecretValue on EVERY exit
      // path — success, throw, and the successTimeoutMs/observeText timeout.
      // dispose() is idempotent and .bytes()-after-dispose throws, so the value
      // is zeroed exactly once regardless of which sink ran last.
      resolved?.value.dispose();
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
