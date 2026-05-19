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
    baselineCandidates: async () => ({ entries: [], readableFps: [] }),
    resolveWithinContainer: async () => ({ value: SECRET }),
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

test("Finding 2: baseline is taken AFTER blind.start/sever (not before requireApproval) — blind is already active when baselineCandidates runs", async () => {
  // The baseline must be taken while blind is active (agent severed), not during
  // the approval window where the agent can still observe the page (§6.1 / Finding 2).
  await withDaemon(async ({ port, services }) => {
    let blindStateAtBaselineCall: unknown = undefined;
    services.browser = stub({
      baselineCandidates: async () => {
        // Capture blind.current() at the moment baselineCandidates is called.
        blindStateAtBaselineCall = services.blind.current();
        return { entries: [], readableFps: [] };
      },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    await call(port, "POST", "/v1/secrets/reveal-capture", containerBody({ approval_id: g.id }));
    // blind.current() returns the domain string when active, null when not.
    // It must be non-null when baselineCandidates was called.
    assert.notEqual(blindStateAtBaselineCall, null,
      "baselineCandidates must be called AFTER blind.start (blind.current() must be non-null at call time)");
    assert.notEqual(blindStateAtBaselineCall, undefined,
      "baselineCandidates must have been called at all");
  });
});
