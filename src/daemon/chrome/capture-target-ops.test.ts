import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import { ShuttleError } from "../../shared/errors.js";
import {
  openCaptureTarget,
  captureFromTarget,
  blankTarget,
  closeTarget,
  getTargetURL,
  listTargets,
} from "./capture-target-ops.js";

interface Sent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * Scripted transport for the capture-target-ops tests. Mirrors the
 * absence-proof / baseline-resolve pattern: every method short-circuits to
 * `reply(...)` so tests can drive the daemon's CDP calls without spinning a
 * real Chrome. Per-test knobs (createdTargetId, targetUrlByCall, readResult)
 * let each test tweak only what it cares about.
 */
class ScriptedTransport extends EventEmitter implements CdpTransport {
  createdTargetId = "T-new";
  // Each call to Target.getTargetInfo pops the next URL. If the queue is
  // empty the last seen URL repeats. Lets tests script "first call returns
  // expected_host, second call returns a redirected host".
  targetUrlQueue: string[] = [];
  defaultTargetUrl = "https://dashboard.stripe.com/login";
  // Result handed back by Runtime.evaluate for the READ_SCRIPT call.
  readResult: {
    ok: boolean;
    reason?: string;
    value?: string;
    source?: "selection" | "focused-field";
    field?: { tag: string; type?: string; name?: string; id?: string; editable: boolean };
    domain?: string;
    title?: string;
    urlHost?: string;
  } = {
    ok: true,
    value: "sk_live_secret_42",
    source: "focused-field",
    field: { tag: "input", type: "password", editable: false },
    domain: "dashboard.stripe.com",
    title: "Login",
    urlHost: "dashboard.stripe.com",
  };
  // For listTargets.
  listResult: Array<{ targetId: string; type: string; url: string }> = [
    { targetId: "T-a", type: "page", url: "https://a.example/" },
    { targetId: "T-b", type: "page", url: "https://b.example/" },
    { targetId: "T-sw", type: "service_worker", url: "sw.js" },
  ];
  // Spy: every Target.* / Page.* / Runtime.* method we issue.
  sentMethods: string[] = [];
  sentParams: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];

  // Toggle: when true, fire Page.loadEventFired immediately after Page.enable.
  emitLoadOnEnable = true;

  close(): void {
    /* no-op */
  }

  send(msg: Sent): void {
    const method = msg.method ?? "";
    this.sentMethods.push(method);
    this.sentParams.push({ method, params: msg.params });
    const reply = (result: unknown): void =>
      queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    switch (method) {
      case "Target.createTarget":
        reply({ targetId: this.createdTargetId });
        return;
      case "Target.attachToTarget":
        reply({ sessionId: "S-1" });
        return;
      case "Target.detachFromTarget":
        reply({});
        return;
      case "Target.getTargetInfo": {
        const url = this.targetUrlQueue.shift() ?? this.defaultTargetUrl;
        const targetId = String(msg.params?.["targetId"] ?? "T-new");
        reply({ targetInfo: { targetId, type: "page", url, attached: true } });
        return;
      }
      case "Target.getTargets":
        reply({ targetInfos: this.listResult });
        return;
      case "Target.closeTarget":
        reply({});
        return;
      case "Page.enable":
        reply({});
        if (this.emitLoadOnEnable) {
          queueMicrotask(() =>
            this.emit("message", {
              method: "Page.loadEventFired",
              params: { timestamp: 1 },
              sessionId: "S-1",
            }),
          );
        }
        return;
      case "Page.navigate":
        reply({ frameId: "F-1" });
        return;
      case "Runtime.evaluate":
        reply({ result: { value: this.readResult } });
        return;
      default:
        reply({});
        return;
    }
  }
}

// ── openCaptureTarget ───────────────────────────────────────────────────────

test("openCaptureTarget creates a non-background tab, waits for load, returns normalized current_host", async () => {
  const t = new ScriptedTransport();
  t.createdTargetId = "T-capture-1";
  t.defaultTargetUrl = "https://Dashboard.Stripe.COM./login"; // mixed case + trailing dot
  const cdp = new CdpClient(t);

  const r = await openCaptureTarget(cdp, "https://dashboard.stripe.com/login");

  assert.equal(r.target_id, "T-capture-1");
  assert.equal(r.current_host, "dashboard.stripe.com", "host must be lowercased + trailing dot stripped");
  // Verify the order: createTarget → attachToTarget → Page.enable → detach → getTargetInfo.
  const ordered = t.sentMethods.filter((m) =>
    [
      "Target.createTarget",
      "Target.attachToTarget",
      "Page.enable",
      "Target.detachFromTarget",
      "Target.getTargetInfo",
    ].includes(m),
  );
  assert.deepEqual(ordered, [
    "Target.createTarget",
    "Target.attachToTarget",
    "Page.enable",
    "Target.detachFromTarget",
    "Target.getTargetInfo",
  ]);
  // Verify background:false (the human MUST be able to type into this tab).
  const create = t.sentParams.find((p) => p.method === "Target.createTarget");
  assert.equal(create?.params?.["background"], false);
});

test("openCaptureTarget tolerates a missing Page.loadEventFired (SPA / no load event) and still returns the URL", async () => {
  const t = new ScriptedTransport();
  t.emitLoadOnEnable = false;
  // Force a short timeout so we don't actually wait 30s in the test.
  const origEnv = process.env.SECRET_SHUTTLE_CAPTURE_LOAD_TIMEOUT_MS;
  process.env.SECRET_SHUTTLE_CAPTURE_LOAD_TIMEOUT_MS = "50";
  try {
    const cdp = new CdpClient(t);
    const r = await openCaptureTarget(cdp, "https://dashboard.stripe.com/login");
    assert.equal(r.target_id, "T-new");
    assert.equal(r.current_host, "dashboard.stripe.com");
  } finally {
    if (origEnv === undefined) delete process.env.SECRET_SHUTTLE_CAPTURE_LOAD_TIMEOUT_MS;
    else process.env.SECRET_SHUTTLE_CAPTURE_LOAD_TIMEOUT_MS = origEnv;
  }
});

// ── captureFromTarget ───────────────────────────────────────────────────────

test("captureFromTarget rejects with bootstrap_capture_redirect_blocked when host has drifted", async () => {
  const t = new ScriptedTransport();
  t.defaultTargetUrl = "https://attacker.example/phish";
  const cdp = new CdpClient(t);

  await assert.rejects(
    () => captureFromTarget(cdp, "T-1", "focused-field", "stripe.com"),
    (e: unknown) => {
      assert.ok(e instanceof ShuttleError, "must be a ShuttleError");
      assert.equal(e.code, "bootstrap_capture_redirect_blocked");
      return true;
    },
  );
  // Critical: Runtime.evaluate MUST NOT have been called — the secret is
  // never read when the host check fails.
  assert.equal(
    t.sentMethods.includes("Runtime.evaluate"),
    false,
    "no in-page script may run after a failed host check",
  );
});

test("captureFromTarget rejects when the target URL is empty (still-loading / about:blank)", async () => {
  const t = new ScriptedTransport();
  t.defaultTargetUrl = "about:blank"; // URL("about:blank").hostname → ""
  const cdp = new CdpClient(t);

  await assert.rejects(
    () => captureFromTarget(cdp, "T-1", "focused-field", "stripe.com"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_capture_redirect_blocked",
  );
  assert.equal(t.sentMethods.includes("Runtime.evaluate"), false);
});

test("captureFromTarget happy path: host matches, READ_SCRIPT returns focused-field, fingerprint is sha256:…", async () => {
  const t = new ScriptedTransport();
  t.defaultTargetUrl = "https://dashboard.stripe.com/api-keys";
  // Expected host with a trailing dot — must still match (normalizeHost on both sides).
  const cdp = new CdpClient(t);

  const r = await captureFromTarget(cdp, "T-1", "focused-field", "dashboard.stripe.com.");

  assert.equal(r.value, "sk_live_secret_42");
  assert.match(r.field_fingerprint, /^sha256:[0-9a-f]{16}$/);
  assert.ok(t.sentMethods.includes("Runtime.evaluate"));
});

test("captureFromTarget refuses focused-field when READ_SCRIPT returned selection (mode mismatch)", async () => {
  const t = new ScriptedTransport();
  t.defaultTargetUrl = "https://dashboard.stripe.com/api-keys";
  t.readResult = {
    ok: true,
    value: "highlighted text",
    source: "selection",
    field: { tag: "div", editable: false },
    domain: "dashboard.stripe.com",
  };
  const cdp = new CdpClient(t);
  await assert.rejects(
    () => captureFromTarget(cdp, "T-1", "focused-field", "dashboard.stripe.com"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_capture_redirect_blocked",
  );
});

test("captureFromTarget refuses selection when READ_SCRIPT returned focused-field (mode mismatch)", async () => {
  const t = new ScriptedTransport();
  t.defaultTargetUrl = "https://dashboard.stripe.com/api-keys";
  // Default readResult is focused-field; we ask for selection.
  const cdp = new CdpClient(t);
  await assert.rejects(
    () => captureFromTarget(cdp, "T-1", "selection", "dashboard.stripe.com"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_capture_redirect_blocked",
  );
});

test("captureFromTarget rejects when READ_SCRIPT reports no_active_element", async () => {
  const t = new ScriptedTransport();
  t.defaultTargetUrl = "https://dashboard.stripe.com/api-keys";
  t.readResult = { ok: false, reason: "no_active_element" };
  const cdp = new CdpClient(t);
  await assert.rejects(
    () => captureFromTarget(cdp, "T-1", "focused-field", "dashboard.stripe.com"),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_capture_redirect_blocked",
  );
});

// ── helpers: blankTarget / closeTarget / getTargetURL / listTargets ─────────

test("blankTarget navigates the target to about:blank", async () => {
  const t = new ScriptedTransport();
  const cdp = new CdpClient(t);
  await blankTarget(cdp, "T-1");
  const nav = t.sentParams.find((p) => p.method === "Page.navigate");
  assert.equal(nav?.params?.["url"], "about:blank");
});

test("closeTarget issues Target.closeTarget with the right targetId", async () => {
  const t = new ScriptedTransport();
  const cdp = new CdpClient(t);
  await closeTarget(cdp, "T-bye");
  const cls = t.sentParams.find((p) => p.method === "Target.closeTarget");
  assert.equal(cls?.params?.["targetId"], "T-bye");
});

test("getTargetURL returns the raw URL from Target.getTargetInfo (no normalisation)", async () => {
  const t = new ScriptedTransport();
  t.defaultTargetUrl = "https://Dashboard.Stripe.COM./after-redirect";
  const cdp = new CdpClient(t);
  const url = await getTargetURL(cdp, "T-1");
  assert.equal(url, "https://Dashboard.Stripe.COM./after-redirect");
});

test("listTargets returns only page targets, projected to { target_id, url }", async () => {
  const t = new ScriptedTransport();
  const cdp = new CdpClient(t);
  const list = await listTargets(cdp);
  assert.deepEqual(list, [
    { target_id: "T-a", url: "https://a.example/" },
    { target_id: "T-b", url: "https://b.example/" },
  ]);
});
