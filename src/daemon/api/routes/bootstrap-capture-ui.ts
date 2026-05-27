// src/daemon/api/routes/bootstrap-capture-ui.ts
//
// Tokenized raw UI routes for the bootstrap capture coordinator (C13).
//
// Three POST routes — `/ui/bootstrap/{capture-step,skip-step,abandon}` —
// settle the pending capture Promise that C11's executor awaits. Auth is
// the single-use `capture_token` query parameter (no bearer): the same
// pattern the approval UI uses (per-URL ui_token), so the hub UI / external
// links can call these routes without holding the root daemon token.
//
// SINGLE-USE invariant: PendingCapturesRegistry.resolveByToken /
// rejectByToken DELETE the entry on success — a second request with the
// same token returns 404. This is enforced by the registry itself; the
// routes here just call through.
//
// Why raw routes (not normal addRoute): the addRoute path applies the
// Host + bearer-token gate. Capture coordination is a UI-driven flow with
// no bearer token in the user-agent's hands — the capture_token IS the
// authorization, scoped tightly to one batch+secret step.
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { captureFromTarget } from "../../chrome/capture-target-ops.js";
import { ShuttleError } from "../../../shared/errors.js";

export function registerBootstrapCaptureUi(server: DaemonServer, services: DaemonServices): void {
  // POST /ui/bootstrap/capture-step?token=<capture_token>
  //
  // Reads the focused field on the registered target (target_id) iff the
  // target is still on `expected_host`. captureFromTarget (C6) performs the
  // host re-check before any DOM read — a redirect to attacker.example
  // throws bootstrap_capture_redirect_blocked WITHOUT reading anything.
  //
  // On success: resolve the pending Promise + return 200 { ok: true }.
  // On error: reject the pending Promise with the same Error (so the
  // executor's state machine sees the correct error code) + return 200
  // { ok: false, error_code }. We return 200 because the route DID process
  // the request — the underlying capture failed, and that failure is now
  // owned by the executor's state machine, not by the HTTP layer.
  server.addRouteRaw("POST", /^\/ui\/bootstrap\/capture-step$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") ?? "";
    const entry = services.pendingCaptures.lookup(token);
    if (entry === undefined) {
      // Unknown / already-consumed token → 404. Single-use semantics: the
      // executor (or a prior skip/abandon call) consumed it and the registry
      // deleted the entry.
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error_code: "capture_token_invalid" }));
      return;
    }
    try {
      // captureFromTarget is the C6 ops function. It re-reads the target's
      // current URL via Target.getTargetInfo and refuses to read the DOM
      // unless the hostname matches the registered expected_host. The cdp
      // here is `services.browserSession.cdp` — guaranteed non-null because
      // the executor only emits the SSE event (with token) AFTER /continue
      // has called ensureBootstrapBrowser (C12).
      const result = await captureFromTarget(
        services.browserSession!.cdp,
        entry.target_id,
        "focused-field",
        entry.expected_host,
      );
      services.pendingCaptures.resolveByToken(token, result);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      // The capture itself failed (host drift, not-editable element, CDP
      // error). Reject the pending Promise with the SAME error so the
      // executor's state machine branches correctly:
      //   - bootstrap_capture_redirect_blocked (real host drift) →
      //     continue-to-next-secret
      //   - bootstrap_capture_field_unreadable (host fine, field state off) →
      //     continue-to-next-secret (T2 split: distinct CLI hint, same flow)
      //   - any other error → unexpected; treated as failed step
      services.pendingCaptures.rejectByToken(token, e as Error);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      const errorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
      res.end(JSON.stringify({ ok: false, error_code: errorCode }));
    }
  });

  // POST /ui/bootstrap/skip-step?token=<capture_token>
  //
  // The user clicked "skip this secret" in the hub UI. Reject the pending
  // Promise with bootstrap_capture_skipped. The executor's state machine
  // treats skip as a "continue to next secret" branch (test 3 in C11).
  server.addRouteRaw("POST", /^\/ui\/bootstrap\/skip-step$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") ?? "";
    const ok = services.pendingCaptures.rejectByToken(
      token,
      new ShuttleError("bootstrap_capture_skipped", "Skipped by user."),
    );
    res.statusCode = ok ? 200 : 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok }));
  });

  // POST /ui/bootstrap/abandon?token=<capture_token>
  //
  // The user clicked "abandon the whole batch" in the hub UI. Reject the
  // pending Promise with bootstrap_capture_aborted. The executor's state
  // machine treats abort as STOP + status="abandoned" (C8 + test 4 in C11).
  //
  // The status transition to "abandoned" happens INSIDE the executor's
  // terminal cleanup path (C11) — this route only rejects the Promise; it
  // does NOT mutate batch.status directly. That separation keeps the state
  // machine the single source of truth for batch lifecycle transitions.
  server.addRouteRaw("POST", /^\/ui\/bootstrap\/abandon$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = url.searchParams.get("token") ?? "";
    const ok = services.pendingCaptures.rejectByToken(
      token,
      new ShuttleError("bootstrap_capture_aborted", "Abandoned by user."),
    );
    res.statusCode = ok ? 200 : 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok }));
  });
}
