import { ShuttleError } from "../../shared/errors.js";
import { blankAllPages } from "./internal-ops.js";
import type { BrowserOps, BackendNodeRef, Baseline } from "./internal-ops.js";
import type { CdpClient } from "./cdp-client.js";

/** Races `p` against a deadline; clears its timer on settle. Single shared copy
 *  (was duplicated in reveal-capture.ts and inject-submit.ts). */
export function withDeadline<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShuttleError(code, `Operation exceeded ${ms}ms.`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export interface CaptureGateArgs {
  revealRef: BackendNodeRef;
  targetRef: BackendNodeRef;
  captureMode: "field" | "container" | "focused-after-reveal";
  hideRef?: BackendNodeRef;
  /** Sampled by the caller before blind (route) or immediately pre-reveal (recipe). */
  baselinePre: Baseline;
}

/** Factored from reveal-capture.ts:340-395. Samples baselinePost, merges readableFps,
 *  clicks reveal, runs the transition gate, applies the observable-before-blind check
 *  (throws reveal_no_transition), and hides. Returns { value, hideDone }. Logic unchanged. */
export async function captureWithTransitionGate(
  browser: BrowserOps,
  cdp: CdpClient | null,
  args: CaptureGateArgs,
): Promise<{ value: string; hideDone: boolean }> {
  const { revealRef, targetRef, captureMode, hideRef, baselinePre } = args;
  // §6.1 baseline sample #2: post-sever, immediately pre-reveal-click.
  const baselinePost = await browser.baselineCandidates(targetRef);
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
  const res = await browser.resolveWithinContainer(targetRef, captureMode, mergedBaseline);
  const value = res.value;
  // §6.1 authoritative observable-before-blind gate (daemon-only; user-ratified).
  // If the captured bytes appeared anywhere in EITHER pre-blind sample's
  // serialized/observable surface, they were script-readable before blind →
  // fail closed. baselinePre/baselinePost.observable are daemon-only and are
  // never returned, audited, logged, or persisted.
  if (value !== "" && (baselinePre.observable.includes(value) || baselinePost.observable.includes(value))) {
    throw new ShuttleError("reveal_no_transition", "Resolved value was observable before blind mode.");
  }
  // Hide BEFORE returning so the page is in its proven-clean state.
  let hideDone = false;
  if (hideRef !== undefined) {
    await browser.clickBackendNode(hideRef);
    hideDone = true;
  } else if (cdp !== null) {
    await blankAllPages(cdp);
    hideDone = true;
  } else {
    // No internal CDP in this build → cannot blank. Treat as hidden
    // only if there is no other neutralization path; the absence proof
    // (next) is the authoritative gate, and a no-CDP build has no
    // observable page surface to leak to anyway.
    hideDone = true;
  }
  return { value, hideDone };
}

export interface InjectGateArgs {
  fieldRef: BackendNodeRef;
  submitRef: BackendNodeRef;
  /** Called once per sink (inject, then proveAbsence) so the caller's SecretValue.bytes()
   *  is exercised for both — caller owns the SecretValue + disposes it. */
  getValue: () => string;
  domain: string;
  successText: string;
  successTimeoutMs: number;
}

/** Factored from inject-submit.ts:180-239. Wraps inject+click in withDeadline (THROWS on
 *  failure/timeout — caller fail-closes), then observeText + (if observed) proveAbsence.
 *  Returns { successObserved, proofPassed }. Logic unchanged. */
export async function injectWithSuccessGate(
  browser: BrowserOps,
  args: InjectGateArgs,
): Promise<{ successObserved: boolean; proofPassed: boolean }> {
  const { fieldRef, submitRef, getValue, domain, successText, successTimeoutMs } = args;
  const injectClickDeadlineMs = Number(process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS) || 30_000;
  await withDeadline(
    (async () => {
      await browser.injectIntoBackendNode(fieldRef, getValue());
      await browser.clickBackendNode(submitRef);
    })(),
    injectClickDeadlineMs,
    "inject_click_timeout",
  );
  let successObserved = false;
  try {
    successObserved = await browser.observeText(domain, successText, successTimeoutMs);
  } catch {
    successObserved = false;
  }
  let proofPassed = false;
  if (successObserved) {
    try {
      proofPassed = (await browser.proveAbsence(getValue())).passed;
    } catch {
      proofPassed = false;
    }
  }
  return { successObserved, proofPassed };
}
