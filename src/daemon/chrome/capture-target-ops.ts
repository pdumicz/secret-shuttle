// src/daemon/chrome/capture-target-ops.ts
//
// Target-bound capture ops for the bootstrap capture flow (Phase C / C6).
//
// Each function operates on an EXPLICITLY-IDENTIFIED Chrome target (CDP
// targetId) instead of the daemon's "best-guess" first page (CdpBrowserOps
// .pickPage). The bootstrap executor opens one capture tab per secret, hands
// control to the human, and later reads the focused field — across that
// window the user could navigate elsewhere. captureFromTarget re-reads the
// target's URL AT CAPTURE TIME and rejects with
// `bootstrap_capture_redirect_blocked` if the hostname no longer matches the
// yml-validated `expected_host` (canonicalised by C1 the same way: lowercase
// + trailing-dot stripped). The hostname check is performed BEFORE any in-page
// capture script runs, so a redirect to attacker.example never gets to read
// document.activeElement.value.
//
// Standalone module by design: the bootstrap flow has different ownership
// semantics than the live `mark`/`reveal-capture` path, and conflating them
// inside CdpBrowserOps would force every existing call site to thread a
// targetId. The few helpers we need (READ_SCRIPT, fieldFingerprint) are
// exported from internal-ops so both flows stay in lockstep.

import type { CdpClient } from "./cdp-client.js";
import { ShuttleError } from "../../shared/errors.js";
import { READ_SCRIPT, fieldFingerprint, type FieldDescriptor } from "./internal-ops.js";

/** Capture mode requested by the bootstrap executor (C11). */
export type CaptureMode = "focused-field" | "selection";

export interface OpenCaptureTargetResult {
  target_id: string;
  /** Lowercased + trailing-dot-stripped, matches the C1 expected_host format. */
  current_host: string;
}

export interface CaptureFromTargetResult {
  value: string;
  field_fingerprint: string;
}

export interface TargetSummary {
  target_id: string;
  url: string;
}

/**
 * Normalise a host the SAME way C1 (`parseBootstrapYml`) does for capture
 * sources: lowercase + strip a single trailing dot. Both sides MUST use this
 * exact rule or the at-capture-time check would reject a target whose URL
 * Chrome happens to canonicalise differently than the yml writer did.
 */
function normalizeHost(raw: string): string {
  const lower = raw.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Extract the hostname from a Target.getTargetInfo URL and normalise it.
 * Returns empty string when the URL is unparseable (e.g. about:blank, or a
 * still-loading target whose URL is empty). Empty string never equals any
 * valid expected_host, so the at-capture-time check will fail closed.
 */
function hostFromUrl(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
  attached?: boolean;
}

async function getTargetInfo(cdp: CdpClient, targetId: string): Promise<TargetInfo> {
  const r = await cdp.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId });
  return r.targetInfo;
}

/**
 * Wait for a target's first `Page.loadEventFired` after attaching. Returns
 * once the load fires OR the deadline elapses (the latter is non-fatal — a
 * SPA that never fires `load` after the initial navigation still surfaces
 * the right URL via Target.getTargetInfo, so we don't want to throw here).
 * Returns true if load actually fired, false on timeout — callers may
 * surface that distinction in audits if useful.
 *
 * Filters by sessionId per cdp-client convention (CdpClient routes events
 * by method only, so a load on a different attached target would otherwise
 * resolve this wait).
 */
function waitForLoad(
  cdp: CdpClient,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const listener = (_params: unknown, sid?: string): void => {
      if (done || sid !== sessionId) return;
      done = true;
      clearTimeout(timer);
      cdp.off("Page.loadEventFired", listener);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cdp.off("Page.loadEventFired", listener);
      resolve(false);
    }, timeoutMs);
    cdp.on("Page.loadEventFired", listener);
  });
}

/**
 * Open a brand-new tab at `url`, wait for it to load, and report the current
 * hostname. The caller pins this `target_id` for the rest of the capture
 * flow — captureFromTarget will refuse to read any other target. The
 * `current_host` is the SAME canonical form as C1's `expected_host` so the
 * coordinator can drift-check it against the yml without re-normalising.
 *
 * A redirect during initial load (e.g. SSO bouncer) is benign here: we report
 * whatever Chrome ended up on, and the coordinator decides whether it matches
 * the expected_host. The security-critical re-check happens later, inside
 * captureFromTarget, at the actual moment of capture.
 */
export async function openCaptureTarget(
  cdp: CdpClient,
  url: string,
): Promise<OpenCaptureTargetResult> {
  // background:false → user-visible. The flow REQUIRES human focus to type
  // the secret; a background tab can't accept keyboard input.
  const created = await cdp.send<{ targetId: string }>(
    "Target.createTarget",
    { url, background: false },
  );
  const targetId = created.targetId;

  // Attach + enable Page so we can wait for loadEventFired. We detach
  // immediately after the wait so the bootstrap flow can re-attach with a
  // fresh session at capture time without colliding with this one.
  const { sessionId } = await cdp.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  try {
    // Register the wait BEFORE Page.enable so a load event emitted very fast
    // after enable (synthetic shims in tests, or a target that was already
    // load-complete when we attached) is never missed. Same pre-register
    // pattern markPick uses for Overlay.inspectNodeRequested.
    const loadTimeoutMs = Number(process.env.SECRET_SHUTTLE_CAPTURE_LOAD_TIMEOUT_MS) || 30_000;
    const loadWait = waitForLoad(cdp, sessionId, loadTimeoutMs);
    await cdp.send("Page.enable", {}, sessionId);
    await loadWait;
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  // Re-read URL via Target.getTargetInfo (NOT Page.frameNavigated params) so
  // we observe the final post-load URL, not the pre-redirect one. A target
  // that's STILL loading would surface an empty URL → normalizeHost("") →
  // empty current_host, which the coordinator handles as "not yet ready".
  const info = await getTargetInfo(cdp, targetId);
  return { target_id: targetId, current_host: hostFromUrl(info.url) };
}

/**
 * Read the focused field (or current selection) from a SPECIFIC target,
 * but ONLY if the target's current hostname still matches `expected_host`.
 *
 * SECURITY: the host check is the entire point of this function. The caller
 * (executor / pending-captures registry) has already validated `expected_host`
 * against the yml at /plan time. Between then and now the user has been
 * driving the page and may have been redirected — possibly maliciously, e.g.
 * an open-redirect on the legitimate site. We refuse to read the page until
 * we've confirmed the host hasn't drifted. Any throw from this function
 * means NOTHING was read (no Runtime.evaluate dispatched, no in-page script
 * executed): the secret stays on the user's screen.
 *
 * Returns { value, field_fingerprint } — same shape the live-mark capture
 * flow uses, so downstream code (vault.upsertSecret, audits) is unchanged.
 */
export async function captureFromTarget(
  cdp: CdpClient,
  targetId: string,
  mode: CaptureMode,
  expectedHost: string,
): Promise<CaptureFromTargetResult> {
  // STEP 1 — host re-check, BEFORE any DOM read. We pull the URL fresh from
  // the browser (not a cached value from openCaptureTarget) so a navigation
  // that happened after open is caught here.
  const info = await getTargetInfo(cdp, targetId);
  const currentHost = hostFromUrl(info.url);
  const wantHost = normalizeHost(expectedHost);
  if (currentHost === "" || currentHost !== wantHost) {
    throw new ShuttleError(
      "bootstrap_capture_redirect_blocked",
      `Capture tab is on ${currentHost || "<no-host>"} but expected ${wantHost}. ` +
        `Navigate back to ${wantHost} and re-trigger capture (the secret was NOT read).`,
    );
  }

  // STEP 2 — only NOW attach + read. Re-uses READ_SCRIPT from internal-ops
  // so the bootstrap path and live-mark path share one definition of "what
  // counts as a focused field / selection capture". The mode parameter
  // narrows which `source` we accept: a request for "focused-field" that
  // happens to find a selection on the page is a usage mismatch, not a
  // capture (caller probably wants to surface a clearer message than
  // "got selection but asked for field").
  const { sessionId } = await cdp.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  try {
    const r = await cdp.send<{
      result: {
        value: {
          ok: boolean;
          reason?: string;
          value?: string;
          source?: "selection" | "focused-field";
          field?: FieldDescriptor;
          domain?: string;
        };
      };
    }>(
      "Runtime.evaluate",
      { expression: READ_SCRIPT, returnByValue: true, awaitPromise: false },
      sessionId,
    );
    const v = r.result.value;
    if (!v.ok || v.value === undefined || v.field === undefined || v.domain === undefined) {
      throw new ShuttleError(
        "bootstrap_capture_redirect_blocked",
        v.reason === "no_active_element"
          ? "No focused element on the capture tab. Focus the field containing the secret and re-trigger capture."
          : v.reason === "not_editable"
            ? "Focused element is not a text field. Click into the input/textarea holding the secret and re-trigger capture."
            : `Could not read focused field (${v.reason ?? "unknown"}).`,
      );
    }
    // Reject selection-when-field-requested and vice versa. READ_SCRIPT
    // returns selection FIRST when one exists, so a user with stray selected
    // text would otherwise silently override a focused-field capture.
    if (mode === "focused-field" && v.source !== "focused-field") {
      throw new ShuttleError(
        "bootstrap_capture_redirect_blocked",
        "Expected a focused-field capture but the page has a non-empty selection. Click into the field (clearing the selection) and re-trigger capture.",
      );
    }
    if (mode === "selection" && v.source !== "selection") {
      throw new ShuttleError(
        "bootstrap_capture_redirect_blocked",
        "Expected a selection capture but the page has no selected text. Select the secret text and re-trigger capture.",
      );
    }
    // Compute the field fingerprint with the SAME seed format the live-mark
    // path uses (domain + target + field shape). backendNodeId is null here
    // — bootstrap capture doesn't resolve a backend node because the human
    // identifies the field by focus, not by `mark pick`. The fingerprint
    // still anchors to the field's tag/type/name/id so downstream audits
    // can match it against future revalidations.
    const fp = fieldFingerprint(v.domain.toLowerCase(), targetId, null, v.field);
    return { value: v.value, field_fingerprint: fp };
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

/**
 * Navigate a target to about:blank. Used by the executor between secrets in
 * a batch so a residual reveal-capture-ish page isn't left visible while the
 * coordinator waits for the human to start the next one.
 */
export async function blankTarget(cdp: CdpClient, targetId: string): Promise<void> {
  const { sessionId } = await cdp.send<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
  );
  try {
    await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

/**
 * Close a target. The executor calls this at end-of-batch (success or
 * abandonment) and on per-secret failure paths.
 */
export async function closeTarget(cdp: CdpClient, targetId: string): Promise<void> {
  await cdp.send("Target.closeTarget", { targetId });
}

/**
 * Return the current URL of a target. Exposed so the coordinator can render
 * a "this is where the user is right now" line without itself constructing
 * a CDP session. Returns the raw URL string — caller does any normalisation.
 */
export async function getTargetURL(cdp: CdpClient, targetId: string): Promise<string> {
  const info = await getTargetInfo(cdp, targetId);
  return info.url;
}

/**
 * Enumerate every page target known to Chrome. Useful for the coordinator's
 * UI ("you have N capture tabs open") and for cleanup audits. Filters to
 * `type === "page"` so service workers / shared workers / iframes don't leak
 * in.
 */
export async function listTargets(cdp: CdpClient): Promise<TargetSummary[]> {
  const r = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  return r.targetInfos
    .filter((t) => t.type === "page")
    .map((t) => ({ target_id: t.targetId, url: t.url }));
}
