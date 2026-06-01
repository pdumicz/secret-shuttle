import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";
import { getShuttlePaths } from "../../shared/config.js";
import { ShuttleError } from "../../shared/errors.js";
import type { BrowserOps } from "../chrome/internal-ops.js";

const SECRET = "whsec_must_never_leak_revealed_value";

function stub(over: Partial<BrowserOps> = {}): BrowserOps {
  const inj = { domain: "dashboard.stripe.com", target_id: "T-1", field: { tag: "input", editable: true }, field_fingerprint: "sha256:fp" };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => inj,
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: "dashboard.stripe.com", target_id: "T-1" }),
    markFocused: async () => { throw new Error("unused"); },
    markPick: async () => { throw new Error("unused"); },
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => inj,
    clickBackendNode: async () => undefined,
    readBackendNodeValue: async () => SECRET,
    baselineCandidates: async () => ({ entries: [], readableFps: [], observable: "" }),
    resolveWithinContainer: async () => ({ value: SECRET }),
    resolveSelectorToHandle: async () => { throw new Error("unused"); },
    selectorMatchCount: async () => 0,
    waitForSelector: async () => false,
    documentHost: async () => "stub.test",
    ...over,
  };
}

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices; home: string }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-rc-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services, home });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(port: number, method: string, p: string, body?: unknown) {
  const init: RequestInit = { method, headers: { Authorization: "Bearer t", "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function setup(services: DaemonServices, port: number, opts: { allowedActions?: string[] } = {}) {
  await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
  // reveal-capture CREATES a new secret named by --name; no pre-existing record needed.
  services.handles.put({
    label: "reveal-button", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
    page_title: "Webhooks", backend_node_id: 31, handle_fingerprint: "sha256:reveal", element_kind: "button",
  });
  services.handles.put({
    label: "secret-card", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
    page_title: "Webhooks", backend_node_id: 32, handle_fingerprint: "sha256:container", element_kind: "other",
  });
  services.handles.put({
    label: "hide-button", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
    page_title: "Webhooks", backend_node_id: 33, handle_fingerprint: "sha256:hide", element_kind: "button",
  });
  void opts;
}

function containerBody(extra: Record<string, unknown> = {}) {
  return {
    name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
    domain: "dashboard.stripe.com", reveal_handle: "reveal-button",
    container_handle: "secret-card", hide_handle: "hide-button",
    allowed_domains: ["dashboard.stripe.com"],
    wait_for_approval: false, ...extra,
  };
}

function bindingFor(over: Record<string, unknown> = {}) {
  return {
    action: "reveal_capture" as const, ref: null, planned_ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
    environment: "production", destination_domain: "dashboard.stripe.com", target_id: "T-1",
    field_fingerprint: null, template_id: null, template_params: null,
    allowed_domains: ["dashboard.stripe.com"],
    reveal_fingerprint: "sha256:reveal", hide_fingerprint: "sha256:hide",
    container_fingerprint: "sha256:container", capture_mode: "container" as const,
    auto_resume: true, reveal_handle_label: "reveal-button",
    hide_handle_label: "hide-button", container_handle_label: "secret-card",
    ...over,
  };
}

test("reveal-capture requires approval even though no approval_id is supplied (force:true)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("refuses if blind mode is already active (no clobber)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.blind.start("dashboard.stripe.com", "other");
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "blind_mode_already_active");
  });
});

test("rejects supplying BOTH field_handle and container_handle (exactly one)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ field_handle: "secret-card" }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("rejects --capture focused-after-reveal without a container_handle", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const b = containerBody();
    delete (b as Record<string, unknown>).container_handle;
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", { ...b, field_handle: undefined, capture: "focused-after-reveal" });
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("reveal handle on a DIFFERENT domain than the container handle is fail-closed", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.handles.put({
      label: "secret-card", target_id: "T-1", domain: "evil.example.com", page_url_host: "evil.example.com",
      page_title: "X", backend_node_id: 32, handle_fingerprint: "sha256:container", element_kind: "other",
    });
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_target_mismatch");
  });
});

test("container mode success: captured:true, blind_mode:false, absence_proof:passed, blind_auto_resume audited, no raw secret in body/audit", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ resolveWithinContainer: async () => ({ value: SECRET }), proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);
    assert.equal((r.body as { absence_proof: string }).absence_proof, "passed");
    assert.equal((r.body as { value_visible_to_agent: boolean }).value_visible_to_agent, false);
    assert.match(String((r.body as { fingerprint: string }).fingerprint), /^hmac-sha256:/);
    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), true);
    assert.equal(log.includes(SECRET), false);
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);
  });
});

test("field mode success goes through resolveWithinContainer(mode=field) — the per-candidate safe→revealed gate (NOT a direct value read)", async () => {
  await withDaemon(async ({ port, services }) => {
    let resolveMode = "";
    let usedRead = false;
    services.browser = stub({
      // field mode MUST apply the §6.1 gate via resolveWithinContainer; a
      // direct readBackendNodeValue here would defeat the protection.
      resolveWithinContainer: async (_r, mode) => { resolveMode = mode; return { value: SECRET }; },
      readBackendNodeValue: async () => { usedRead = true; return "WRONG"; },
    });
    await setup(services, port);
    services.handles.put({
      label: "secret-field", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
      page_title: "Webhooks", backend_node_id: 34, handle_fingerprint: "sha256:thefield", element_kind: "field",
    });
    const g = services.approvals.create(bindingFor({
      capture_mode: "field", field_fingerprint: "sha256:thefield",
      container_fingerprint: null, container_handle_label: null, field_handle_label: "secret-field",
    }));
    services.approvals.approve(g.id);
    const b = containerBody({ approval_id: g.id });
    delete (b as Record<string, unknown>).container_handle;
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", { ...b, field_handle: "secret-field" });
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
    assert.equal(resolveMode, "field");      // gate applied via resolveWithinContainer
    assert.equal(usedRead, false);           // NOT the direct §12 reader
  });
});

test("field mode gate: a field already script-readable & unchanged pre-reveal → resolveWithinContainer fails closed → captured:unknown, blind stays active (spec §6.1)", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({
      // resolveWithinContainer's per-candidate gate rejects a field whose
      // baseline entry was `readable` and unchanged (no safe→revealed
      // transition): the secret was observable without blind protection.
      resolveWithinContainer: async () => { throw new ShuttleError("reveal_no_transition", "No safe→revealed candidate after reveal."); },
    });
    await setup(services, port);
    services.handles.put({
      label: "secret-field", target_id: "T-1", domain: "dashboard.stripe.com", page_url_host: "dashboard.stripe.com",
      page_title: "Webhooks", backend_node_id: 34, handle_fingerprint: "sha256:thefield", element_kind: "field",
    });
    const g = services.approvals.create(bindingFor({
      capture_mode: "field", field_fingerprint: "sha256:thefield",
      container_fingerprint: null, container_handle_label: null, field_handle_label: "secret-field",
    }));
    services.approvals.approve(g.id);
    const b = containerBody({ approval_id: g.id });
    delete (b as Record<string, unknown>).container_handle;
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", { ...b, field_handle: "secret-field" });
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.notEqual(services.blind.current(), null); // stays blind — gate failed closed
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("focused-after-reveal mode resolves via resolveWithinContainer(mode=focused-after-reveal)", async () => {
  await withDaemon(async ({ port, services }) => {
    let seenMode = "";
    services.browser = stub({
      resolveWithinContainer: async (_r, mode) => { seenMode = mode; return { value: SECRET }; },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor({ capture_mode: "focused-after-reveal" }));
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id, capture: "focused-after-reveal" }));
    assert.equal(r.status, 200);
    assert.equal(seenMode, "focused-after-reveal");
  });
});

test("resolution fail-closed (no single safe→revealed candidate: ambiguous / not-contained / already-readable all collapse to reveal_no_transition) → stays blind, captured:unknown, manual_recovery_required, blank attempted, no auto-resume", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({
      // The real resolveWithinContainer throws ONE fail-closed code: a null
      // RemoteObject from RESOLVE_SCAN_FN (zero/>1 transition-eligible OR
      // already-readable-unchanged) → reveal_no_transition. The route's
      // post-reveal catch is generic, so the specific code does not change
      // the enum-only captured:"unknown" response either way.
      resolveWithinContainer: async () => { throw new ShuttleError("reveal_no_transition", "No single safe→revealed candidate after reveal."); },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.equal("absence_proof" in r.body, false);
    assert.notEqual(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("pre-reveal handle revalidation failure (post-approval) ends blind and errors — safe, nothing revealed", async () => {
  await withDaemon(async ({ port, services }) => {
    let calls = 0;
    services.browser = stub({
      revalidateHandle: async () => { calls += 1; if (calls > 2) throw new ShuttleError("handle_invalid", "gone"); },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_invalid");
    assert.equal(services.blind.current(), null); // blind ended (safe — nothing revealed)
  });
});

test("post-reveal failure (resolve hangs) → withDeadline fires, stays blind, captured:unknown, blank attempted", async () => {
  await withDaemon(async ({ port, services }) => {
    process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS = "150";
    services.browser = stub({ resolveWithinContainer: () => new Promise<{ value: string }>(() => {}) }); // never resolves
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    delete process.env.SECRET_SHUTTLE_REVEAL_DEADLINE_MS;
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.notEqual(services.blind.current(), null);
  });
});

test("hide-handle absent → blankAllPages fallback path; captured non-empty + blank ok + proof passed → auto-resume", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({ proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor({ hide_fingerprint: null, hide_handle_label: null }));
    services.approvals.approve(g.id);
    const b = containerBody({ approval_id: g.id });
    delete (b as Record<string, unknown>).hide_handle;
    // No services.cdp in unit harness → blank is best-effort no-op; the route's
    // auto-resume gate still requires proof passed (stub: passed) so it resumes.
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", b);
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
  });
});

test("absence proof inconclusive → stays blind, captured:unknown, manual_recovery_required, no auto-resume", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ proveAbsence: async () => ({ passed: false }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.notEqual(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("no raw secret appears in any response body (extends the no-leak assertion)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);
  });
});

test("Finding 2 (dual-sample): call #1 (pre-approval) runs with blind NOT active; call #2 (post-sever) runs with blind active — both timing invariants enforced", async () => {
  // Two baseline calls exist: #1 pre-approval (agent still observing), #2 post-sever
  // (blind active). Call #1 must see blind.current()===null; call #2 must see non-null.
  await withDaemon(async ({ port, services }) => {
    let callIndex = 0;
    const blindStatePerCall: unknown[] = [];
    services.browser = stub({
      baselineCandidates: async () => {
        callIndex += 1;
        blindStatePerCall.push(services.blind.current());
        return { entries: [], readableFps: [], observable: "" };
      },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(callIndex, 2,
      "baselineCandidates must be called exactly 2 times (pre-approval + post-sever)");
    assert.strictEqual(blindStatePerCall[0], null,
      "call #1 (pre-approval): blind.current() must be null — agent still observing at this point");
    assert.notEqual(blindStatePerCall[1], null,
      "call #2 (post-sever): blind.current() must be non-null — blind started before this sample");
  });
});

test("§6.1 sever→baseline erase residual closed: pre-approval∪post-sever readableFps union — a value erased between samples remains in the reject set", async () => {
  // Adversarial scenario: agent page-JS runs between sever and the post-sever baseline,
  // erasing a pre-observed value from the DOM. Without the union, the post-sever-only
  // baseline would have an empty readableFps and the value would escape the reject set.
  // With the union, the pre-approval sample's HASH_OF_PREOBSERVED persists.
  await withDaemon(async ({ port, services }) => {
    let baselineCallIndex = 0;
    let capturedBaselineArg: { entries: unknown[]; readableFps: string[] } | undefined;
    services.browser = stub({
      baselineCandidates: async () => {
        baselineCallIndex += 1;
        if (baselineCallIndex === 1) {
          // Pre-approval: the value is still observable — agent saw it.
          return { entries: [], readableFps: ["HASH_OF_PREOBSERVED"], observable: "" };
        } else {
          // Post-sever: adversarial JS erased the value from the DOM.
          return { entries: [], readableFps: [], observable: "" };
        }
      },
      resolveWithinContainer: async (_ref, _mode, baseline) => {
        // Capture the merged baseline that the route passes in.
        capturedBaselineArg = baseline as { entries: unknown[]; readableFps: string[] };
        return { value: SECRET };
      },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal(baselineCallIndex, 2,
      "baselineCandidates must be called exactly 2 times");
    assert.ok(capturedBaselineArg !== undefined,
      "resolveWithinContainer must have been called with a baseline argument");
    assert.ok(
      capturedBaselineArg!.readableFps.includes("HASH_OF_PREOBSERVED"),
      "merged baseline readableFps must include the pre-approval hash even though post-sever sample erased it (union closes the residual)",
    );
    // entries must come from the post-sever (call #2) sample — [] in this stub.
    assert.deepEqual(capturedBaselineArg!.entries, [],
      "entries must come from the post-sever sample (transition gate reflects state at reveal time)");
  });
});

test("§6.1 union does NOT regress legitimate capture: both baseline calls return empty readableFps → captured:true", async () => {
  // Monotonicity control: in a genuine masked/empty→revealed flow the secret is
  // absent at BOTH sample points (it only appears after the reveal click).
  // The union of two empty sets is empty → the secret hash is not rejected → captured.
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({
      baselineCandidates: async () => ({ entries: [], readableFps: [], observable: "" }),
      resolveWithinContainer: async () => ({ value: SECRET }),
      proveAbsence: async () => ({ passed: true }),
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal((r.body as { captured: unknown }).captured, true,
      "legitimate masked→revealed flow must still yield captured:true with both samples empty");
  });
});

test("§6.1 substring/attribute observable gate: a captured value that appears in a pre-blind sample's observable blob fails closed", async () => {
  // Round-4 defect: the whole-element hash gate misses a secret that is a SUBSTRING
  // of label text or lives in a script-readable attribute. The daemon-side observable
  // gate must catch it: if capturedValue appears anywhere in EITHER pre-blind sample's
  // observable string, we fail closed (captured:"unknown", blind stays active).
  const LIVE_VALUE = "whsec_LIVE_OBSERVABLE_X9f2";
  await withDaemon(async ({ port, services, home }) => {
    let callIndex = 0;
    services.browser = stub({
      baselineCandidates: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          // Pre-approval sample: the secret appears as a SUBSTRING of label text in the
          // serialized subtree — script-observable before blind mode.
          return { entries: [], readableFps: [], observable: `prefix Signing secret: ${LIVE_VALUE} suffix` };
        } else {
          // Post-sever sample: observable blob is clean (value erased post-sever).
          return { entries: [], readableFps: [], observable: "" };
        }
      },
      resolveWithinContainer: async () => ({ value: LIVE_VALUE }),
      proveAbsence: async () => ({ passed: true }),
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    // Must fail closed: observable gate caught the pre-blind substring match.
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, "unknown",
      "observable-before-blind value must fail closed (captured:unknown)");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true,
      "blind must stay active after observable gate fires");
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    // Blind must remain active (no auto-resume).
    assert.notEqual(services.blind.current(), null,
      "blind.current() must be non-null — gate must not auto-resume");
    // No blind_auto_resume audit event.
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false,
      "audit must NOT contain blind_auto_resume after observable gate fires");
    // Response and audit must not contain the raw captured value or observable blob.
    assert.equal(JSON.stringify(r.body).includes(LIVE_VALUE), false,
      "response body must NOT contain the raw captured value");
    assert.equal(log.includes(LIVE_VALUE), false,
      "audit must NOT contain the raw captured value");
  });
});

test("§6.1 observable gate control: observable blobs not containing the captured value → captured:true (no regression)", async () => {
  // Monotonicity: the gate must NOT block a legitimate capture where the captured
  // value was never in any pre-blind observable (genuine masked→revealed flow).
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({
      baselineCandidates: async () => ({ entries: [], readableFps: [], observable: "some label text with no secret" }),
      resolveWithinContainer: async () => ({ value: SECRET }),
      proveAbsence: async () => ({ passed: true }),
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    assert.equal((r.body as { captured: unknown }).captured, true,
      "observable gate must NOT block a genuine reveal where value was absent from pre-blind observables");
  });
});

test("§6.1 observable gate shape-guard: baselineCandidates missing observable field → reveal_baseline_failed", async () => {
  // The shape guard must also require observable:string. A missing or non-string
  // observable is a structural violation → fail closed at the baseline stage.
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({
      // Deliberately omit observable to trigger the shape guard.
      baselineCandidates: async () => ({ entries: [], readableFps: [] } as unknown as { entries: []; readableFps: []; observable: string }),
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    // Shape guard fires before blind is started (pre-approval), so it throws.
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "reveal_baseline_failed",
      "missing observable must trigger reveal_baseline_failed shape guard");
  });
});

/** Read every line of audit.jsonl and parse as JSON. Used by the session
 *  tests below to assert which audit records the route wrote. */
interface AuditLine {
  action: string;
  ok?: boolean;
  planned_ref?: string;
  ref?: string;
  session_id?: string;
  error_code?: string;
  [k: string]: unknown;
}
async function readAuditLines(home: string): Promise<AuditLine[]> {
  const text = await readFile(getShuttlePaths(home).auditLogPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditLine);
}

test("reveal-capture: matching session mints grant → audit carries session_id; sessionStore.uses incremented", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    // Mint and approve a reveal-capture session covering this planned_ref + domain.
    // Matcher uses binding.planned_ref (binding.ref is null for reveal-capture)
    // — see session-matchers.ts revealCaptureMatches.
    const sg = services.sessionStore.create({
      actions: ["reveal-capture"],
      ref_glob: "ss://stripe/prod/*",
      destination_domains: ["dashboard.stripe.com"],
      ttl_ms: 60_000,
    });
    services.sessionStore.approve(sg.id);

    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ session_id: sg.id }));
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    assert.equal((r.body as { captured: unknown }).captured, true);

    // Audit: the most-recent reveal_capture line carries session_id with ok:true.
    const lines = await readAuditLines(home);
    const rcLine = [...lines].reverse().find((l) => l.action === "reveal_capture");
    assert.ok(rcLine, "expected at least one reveal_capture audit line");
    assert.equal(rcLine!.ok, true, "success audit must carry ok:true");
    assert.equal(
      rcLine!.session_id,
      sg.id,
      "success audit must carry session_id of the consumed session",
    );

    // Session usage counter advanced exactly once.
    const session = services.sessionStore.get(sg.id)!;
    assert.equal(session.uses, 1, "session.uses should be incremented to 1");
  });
});

test("reveal-capture: failure AFTER session mint still records session_id; uses still incremented", async () => {
  // Exploit the pre-action revalidate path: revalidateHandle succeeds on the
  // first three calls (pre-approval — reveal, target, hide; BEFORE
  // requireApproval mints the session grant) and throws on the fourth (post-
  // approval, pre-action). The session IS minted and the use counter IS
  // incremented; the throw lands in the outer catch and the failure audit
  // MUST carry session_id.
  await withDaemon(async ({ port, services, home }) => {
    let calls = 0;
    services.browser = stub({
      revalidateHandle: async () => {
        calls += 1;
        if (calls > 3) throw new ShuttleError("handle_invalid", "gone");
      },
    });
    await setup(services, port);
    const sg = services.sessionStore.create({
      actions: ["reveal-capture"],
      ref_glob: "ss://stripe/prod/*",
      destination_domains: ["dashboard.stripe.com"],
      ttl_ms: 60_000,
    });
    services.sessionStore.approve(sg.id);

    const r = await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ session_id: sg.id }));
    assert.equal(r.status, 400);
    assert.equal(
      (r.body as { error: { code: string } }).error.code,
      "handle_invalid",
      "post-mint failure must surface as handle_invalid (pre-action revalidate re-thrown)",
    );

    // Audit: the most-recent reveal_capture failure line carries session_id with ok:false.
    const lines = await readAuditLines(home);
    const rcLine = [...lines].reverse().find((l) => l.action === "reveal_capture");
    assert.ok(rcLine, "expected at least one reveal_capture audit line");
    assert.equal(rcLine!.ok, false, "failure audit must carry ok:false");
    assert.equal(
      rcLine!.session_id,
      sg.id,
      "post-mint failure audit MUST still carry session_id (the session was charged a use)",
    );
    assert.equal(
      rcLine!.error_code,
      "handle_invalid",
      "failure audit must carry the underlying error_code",
    );

    // Session usage counter still advanced — the mint was real.
    const session = services.sessionStore.get(sg.id)!;
    assert.equal(
      session.uses,
      1,
      "session.uses must still be 1: session was minted before the post-mint throw",
    );
  });
});
