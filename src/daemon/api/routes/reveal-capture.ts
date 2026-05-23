import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import { domainMatches } from "../../../policy/domain-policy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { canonicalEnvironment, buildSecretRef } from "../../../shared/refs.js";
import { asObject, optString, reqString } from "../validate.js";
import { blankAllPages, disableObservationDomains } from "../../chrome/internal-ops.js";
import type { Baseline, BackendNodeRef } from "../../chrome/internal-ops.js";
import { enforceDomain } from "./secrets.js";
import { autoResumeBlind } from "../../blind-auto-resume.js";
import type { BrowserHandle } from "../../browser-handles.js";

interface RevealCaptureBody {
  name: string;
  environment: string;
  source: string;
  domain?: string;
  reveal_handle: string;
  field_handle?: string;
  container_handle?: string;
  capture?: "focused-after-reveal";
  hide_handle?: string;
  allowed_domains?: string[];
  description?: string;
  force?: boolean;
  approval_id?: string;
  wait_for_approval?: boolean;
  session_id?: string;
}

export function registerRevealCapture(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/secrets/reveal-capture", async (_req, raw) => {
    services.lock.requireKey();
    const o = asObject(raw);
    const name = reqString(o, "name");
    const environment = reqString(o, "environment");
    const source = reqString(o, "source");
    const revealHandleLabel = reqString(o, "reveal_handle");
    const fieldHandleLabel = optString(o, "field_handle");
    const containerHandleLabel = optString(o, "container_handle");
    const hideHandleLabel = optString(o, "hide_handle");
    const captureOpt = optString(o, "capture");
    const b = raw as RevealCaptureBody;
    let plannedRef: string | undefined;
    // Hoisted OUTSIDE the try so a post-mint failure (e.g. pre-action
    // revalidateHandle throws AFTER requireApproval consumed the session)
    // still carries grant.session_id into the failure audit.  Optional-chained
    // at use site because grant remains undefined if requireApproval itself
    // threw (pre-mint failure), in which case no session was consumed and
    // audit MUST NOT carry session_id.
    let grant: ApprovalGrant | undefined;
    try {
      if (services.browser === null) {
        throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      }
      const browser = services.browser;

      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is already active; run `secret-shuttle blind end` before reveal-capture.",
        );
      }

      // Exactly one of field_handle / container_handle (latter optionally with
      // --capture focused-after-reveal).
      const haveField = fieldHandleLabel !== undefined;
      const haveContainer = containerHandleLabel !== undefined;
      if (haveField === haveContainer) {
        throw new ShuttleError("bad_request", "Supply exactly one of field_handle or container_handle.");
      }
      let captureMode: "field" | "container" | "focused-after-reveal";
      if (haveField) {
        if (captureOpt !== undefined) {
          throw new ShuttleError("bad_request", "--capture focused-after-reveal requires container_handle, not field_handle.");
        }
        captureMode = "field";
      } else if (captureOpt === "focused-after-reveal") {
        captureMode = "focused-after-reveal";
      } else if (captureOpt === undefined) {
        captureMode = "container";
      } else {
        throw new ShuttleError("bad_request", "capture: only 'focused-after-reveal' is valid (with container_handle).");
      }

      const env = canonicalEnvironment(environment);
      plannedRef = buildSecretRef(source, env, name);

      const revealHandle = services.handles.get(revealHandleLabel);
      if (revealHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${revealHandleLabel}.`);
      const targetLabel = haveField ? (fieldHandleLabel as string) : (containerHandleLabel as string);
      const targetHandle = services.handles.get(targetLabel);
      if (targetHandle === undefined) throw new ShuttleError("handle_not_found", `No active mark labelled ${targetLabel}.`);
      const hideHandle = hideHandleLabel !== undefined ? services.handles.get(hideHandleLabel) : undefined;
      if (hideHandleLabel !== undefined && hideHandle === undefined) {
        throw new ShuttleError("handle_not_found", `No active mark labelled ${hideHandleLabel}.`);
      }

      // Revalidate while observation is still safe (§3.4 / §6.2 step 2).
      await browser.revalidateHandle(revealHandle);
      await browser.revalidateHandle(targetHandle);
      if (hideHandle !== undefined) await browser.revalidateHandle(hideHandle);

      if (revealHandle.element_kind !== "button" && revealHandle.element_kind !== "link") {
        throw new ShuttleError("handle_kind_mismatch", "reveal_handle must be a button or link.");
      }
      if (hideHandle !== undefined && hideHandle.element_kind !== "button" && hideHandle.element_kind !== "link") {
        throw new ShuttleError("handle_kind_mismatch", "hide_handle must be a button or link.");
      }
      if (captureMode === "field" && targetHandle.element_kind !== "field") {
        throw new ShuttleError("handle_kind_mismatch", "field_handle must be a field.");
      }

      // Derive domain from the reveal handle; the field/container handle (and the
      // hide handle, if any) MUST share the reveal handle's target & domain so
      // the click/resolve cannot land on a different tab/site than approved.
      const domain = revealHandle.domain;
      const sameTargetDomain = (h: BrowserHandle): boolean =>
        h.target_id === revealHandle.target_id && h.domain === revealHandle.domain;
      if (!sameTargetDomain(targetHandle) || (hideHandle !== undefined && !sameTargetDomain(hideHandle))) {
        throw new ShuttleError(
          "handle_target_mismatch",
          "field/container and hide handles must share the reveal handle's page/target and domain.",
        );
      }
      if (b.domain !== undefined && !domainMatches(domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Reveal handle domain ${domain} != ${b.domain}.`);
      }

      const effectiveAllowed = (b.allowed_domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (env === "production" && effectiveAllowed.length === 0) {
        throw new ShuttleError("missing_allow_domain", "Production secrets require at least one allowed domain.");
      }
      enforceDomain(domain, effectiveAllowed, "reveal-capture");

      // §6.1 baseline sample #1: pre-approval (agent still observing). Unioned with
      // the post-sever sample so a value observable at EITHER time fails closed —
      // closes both the approval-window staleness hole and the sever→baseline
      // agent-JS-erase residual.
      const baselinePre = await browser.baselineCandidates({
        target_id: targetHandle.target_id,
        backend_node_id: targetHandle.backend_node_id,
      });
      // Runtime shape guard: observable is a daemon-only field that must be present.
      // Absence means an outdated or non-conforming BrowserOps implementation → fail closed.
      if (typeof (baselinePre as { observable?: unknown }).observable !== "string") {
        throw new ShuttleError("reveal_baseline_failed", "Could not baseline the approved subtree.");
      }

      const binding: ApprovalBinding = {
        action: "reveal_capture",
        ref: null,
        planned_ref: plannedRef,
        environment: env,
        destination_domain: domain,
        target_id: targetHandle.target_id,
        field_fingerprint: captureMode === "field" ? targetHandle.handle_fingerprint : null,
        template_id: null,
        template_params: null,
        allowed_domains: effectiveAllowed,
        reveal_fingerprint: revealHandle.handle_fingerprint,
        capture_mode: captureMode,
        auto_resume: true,
        reveal_handle_label: revealHandle.label,
        ...(captureMode !== "field"
          ? { container_fingerprint: targetHandle.handle_fingerprint, container_handle_label: targetHandle.label }
          : { field_handle_label: targetHandle.label }),
        ...(hideHandle !== undefined
          ? { hide_fingerprint: hideHandle.handle_fingerprint, hide_handle_label: hideHandle.label }
          : {}),
        ...(targetHandle.page_title !== "" ? { page_title: targetHandle.page_title } : {}),
        ...(targetHandle.page_url_host !== "" ? { page_url_host: targetHandle.page_url_host } : {}),
      };
      // Single requireApproval call — handles both the initial (no approval_id)
      // and the retry (approval_id supplied) paths.  When session_id is set and
      // the binding matches a reveal-capture session pattern (planned_ref +
      // destination_domain), the call mints a used grant from the session and
      // the audits emitted below carry grant.session_id; otherwise the call
      // falls back to the single-use flow and grant.session_id is undefined.
      grant = await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        force: true,
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        ...(b.session_id !== undefined ? { sessionId: b.session_id } : {}),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Daemon OWNS the blind window: black out the agent BEFORE reveal.
      services.blind.start(domain, "reveal_capture");
      if (services.cdp !== null) {
        await disableObservationDomains(services.cdp).catch(() => undefined);
      }
      services.cdpProxy?.severAgentConnections();

      // Re-revalidate post-approval, pre-action. Failure here = NOTHING revealed
      // → safe to end blind and rethrow (mirrors inject-submit pre-write path).
      try {
        await browser.revalidateHandle(revealHandle);
        await browser.revalidateHandle(targetHandle);
        if (hideHandle !== undefined) await browser.revalidateHandle(hideHandle);
      } catch (preActionErr) {
        services.blind.end();
        throw preActionErr;
      }

      // From the reveal click onward the secret MAY be exposed. Any failure
      // (incl. a HANG) MUST NOT auto-resume: blind stays ACTIVE; respond
      // fail-closed (captured:"unknown"). The whole secret-bearing sequence
      // (reveal → resolve → read → hide) is wrapped in an overall deadline so a
      // hung CDP frame becomes a caught failure (mirrors inject-submit I3).
      const revealDeadlineMs = Number(process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS) || 30_000;
      let capturedValue = "";
      let hideDone = false;
      try {
        await withDeadline(
          (async () => {
            // §6.1 baseline sample #2: post-sever, immediately pre-reveal-click.
            const baselinePost = await browser.baselineCandidates({
              target_id: targetHandle.target_id,
              backend_node_id: targetHandle.backend_node_id,
            });
            // Union the readableFps from both samples: a value script-observable at
            // EITHER the pre-approval point OR the post-sever point is in the reject set.
            // entries come from baselinePost (the post-sever/current state) — the
            // path-keyed safety transition gate must reflect the state at reveal time;
            // using stale pre-approval entries would reintroduce Finding-2-class staleness.
            const mergedBaseline: Baseline = {
              entries: baselinePost.entries,
              readableFps: Array.from(new Set([...baselinePre.readableFps, ...baselinePost.readableFps])),
              observable: "", // not used by resolveWithinContainer; daemon-only gate uses baselinePre/baselinePost.observable directly
            };
            const revealRef: BackendNodeRef = { target_id: revealHandle.target_id, backend_node_id: revealHandle.backend_node_id };
            await browser.clickBackendNode(revealRef);
            // ALL THREE modes go through resolveWithinContainer so the §6.1
            // per-chosen-candidate safe→revealed gate is enforced uniformly
            // (defined once / tested once). For `field` the approved field
            // handle's OWN backend node is the subtree root: the field is its
            // own sole candidate, so a field that was already script-readable
            // and UNCHANGED pre-reveal (its baseline entry is `readable`) is
            // NOT transition-eligible → fail closed (the secret was observable
            // without blind protection, spec §6.1). A safe→revealed field is
            // captured. `readBackendNodeValue` is NOT the field-mode path.
            const res = await browser.resolveWithinContainer(
              { target_id: targetHandle.target_id, backend_node_id: targetHandle.backend_node_id },
              captureMode,
              mergedBaseline,
            );
            capturedValue = res.value;
            // §6.1 authoritative observable-before-blind gate (daemon-only; user-ratified).
            // If the captured bytes appeared anywhere in EITHER pre-blind sample's
            // serialized/observable surface, they were script-readable before blind →
            // fail closed. baselinePre/baselinePost.observable are daemon-only and are
            // never returned, audited, logged, or persisted.
            if (
              capturedValue !== "" &&
              (baselinePre.observable.includes(capturedValue) || baselinePost.observable.includes(capturedValue))
            ) {
              throw new ShuttleError("reveal_no_transition", "Resolved value was observable before blind mode.");
            }
            // Hide BEFORE returning so the page is in its proven-clean state.
            if (hideHandle !== undefined) {
              await browser.clickBackendNode({ target_id: hideHandle.target_id, backend_node_id: hideHandle.backend_node_id });
              hideDone = true;
            } else if (services.cdp !== null) {
              await blankAllPages(services.cdp);
              hideDone = true;
            } else {
              // No internal CDP in this build → cannot blank. Treat as hidden
              // only if there is no other neutralization path; the absence proof
              // (next) is the authoritative gate, and a no-CDP build has no
              // observable page surface to leak to anyway.
              hideDone = true;
            }
          })(),
          revealDeadlineMs,
          "reveal_capture_timeout",
        );
      } catch {
        // Post-reveal failure (thrown reveal/resolve/read/hide OR the deadline):
        // the secret may be on the page. Proactively neutralize with the SAME
        // hardened primitive /v1/blind/end uses (best-effort, bounded — its
        // failure must NOT change the response; blind STAYS active and the
        // human-approved /v1/blind/end remains the authoritative recovery).
        if (services.cdp !== null) {
          const blankMs = Number(process.env.SECRET_SHUTTLE_BLANK_DEADLINE_MS) || 15_000;
          await withDeadline(blankAllPages(services.cdp), blankMs, "blank_timeout").catch(() => undefined);
        }
        await writeDaemonAudit({
          action: "reveal_capture", ok: false, planned_ref: plannedRef, environment: env,
          domain, captured: "unknown", blind_mode: true,
          ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
        });
        return {
          captured: "unknown", blind_mode: true,
          next: "manual_recovery_required", value_visible_to_agent: false,
        };
      }

      // Store the captured value (it never leaves the daemon). Only on a
      // non-empty capture; an empty value is a fail-closed outcome.
      let meta: { ref: string; fingerprint: string } | undefined;
      if (capturedValue !== "") {
        meta = await services.vault.upsertSecret({
          name, environment: env, source, value: capturedValue,
          allowedDomains: effectiveAllowed,
          ...(b.description !== undefined ? { description: b.description } : {}),
          ...(b.force !== undefined ? { force: b.force } : {}),
        });
      }

      // Absence proof for the captured value (REUSED Phase-2 hardened proof).
      let proofPassed = false;
      if (capturedValue !== "" && hideDone) {
        try {
          proofPassed = (await browser.proveAbsence(capturedValue)).passed;
        } catch {
          proofPassed = false;
        }
      }

      if (capturedValue !== "" && hideDone && proofPassed && meta !== undefined) {
        // T7-M1: autoResumeBlind throws BEFORE it ends blind if preconditions
        // fail; treat ANY throw as "not provably safe" → fall through to
        // fail-closed instead of 500ing via the outer catch.
        try {
          await autoResumeBlind(services, {
            op: "reveal_capture", domain, success_signal: "secret_captured", absence_proof: "passed",
          });
          await writeDaemonAudit({
            action: "reveal_capture", ok: true, planned_ref: plannedRef, ref: meta.ref, environment: env,
            domain, captured: true, success_signal: "secret_captured", absence_proof: "passed", blind_mode: false,
            ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
          });
          return {
            captured: true, secret_ref: meta.ref,
            fingerprint: meta.fingerprint, absence_proof: "passed",
            blind_mode: false, value_visible_to_agent: false,
          };
        } catch {
          // autoResumeBlind refused/failed → blind remains active → fail-closed.
        }
      }

      await writeDaemonAudit({
        action: "reveal_capture", ok: true, planned_ref: plannedRef,
        ...(meta !== undefined ? { ref: meta.ref } : {}),
        environment: env, domain, captured: "unknown", blind_mode: true,
        ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      return {
        captured: "unknown", blind_mode: true,
        next: "manual_recovery_required", value_visible_to_agent: false,
      };
    } catch (err) {
      // Errors before blind.start (handle/kind/domain/approval) → blind never
      // started. The pre-action path already ended blind & is rethrowing here.
      await writeDaemonAudit({
        action: "reveal_capture",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(plannedRef !== undefined ? { planned_ref: plannedRef } : {}),
        // Optional-chain: grant is undefined if requireApproval itself threw
        // (pre-mint failure — no session consumed → audit MUST NOT carry
        // session_id).  Otherwise grant.session_id is the source session iff
        // the binding matched the session pattern.
        ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
      throw err;
    }
  });
}

// Mirrors inject-submit.ts's withDeadline. Races `p` against a deadline; clears
// its timer on settle (no leaked timer per successful call). If `p` hangs it
// stays orphaned but the route fails closed instead of hanging — the post-reveal
// catch maps the rejection to captured:"unknown" / blind stays active.
function withDeadline<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShuttleError(code, `Operation exceeded ${ms}ms.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
