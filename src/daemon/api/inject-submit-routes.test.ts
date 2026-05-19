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

function stub(over: Partial<BrowserOps> = {}): BrowserOps {
  const inj = { domain: "vercel.com", target_id: "T-1", field: { tag: "input", editable: true }, field_fingerprint: "sha256:fp" };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => inj,
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: "vercel.com", target_id: "T-1" }),
    markFocused: async () => { throw new Error("unused"); },
    markPick: async () => { throw new Error("unused"); },
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => inj,
    clickBackendNode: async () => undefined,
    ...over,
  };
}

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices; home: string }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-is-"));
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

const SECRET = "whsec_must_never_leak_value";

async function setup(services: DaemonServices, port: number, opts: { allowedActions?: string[] } = {}) {
  await call(port, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
  await services.vault.upsertSecret({
    name: "WH", environment: "production", source: "stripe", value: SECRET,
    allowedDomains: ["vercel.com"],
    ...(opts.allowedActions !== undefined ? { allowedActions: opts.allowedActions as never } : {}),
  });
  services.handles.put({
    label: "value-field", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
    page_title: "Proj", backend_node_id: 11, handle_fingerprint: "sha256:field", element_kind: "field",
  });
  services.handles.put({
    label: "submit-btn", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
    page_title: "Proj", backend_node_id: 22, handle_fingerprint: "sha256:submit", element_kind: "button",
  });
}

function body(extra: Record<string, unknown> = {}) {
  return {
    ref: "ss://stripe/prod/WH", domain: "vercel.com",
    field_handle: "value-field", submit_handle: "submit-btn",
    success_text: "Environment Variable Added",
    wait_for_approval: false, ...extra,
  };
}

test("inject-submit requires approval even though no approval_id is supplied (force:true)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "approval_required");
  });
});

test("a legacy secret without inject_submit is denied (no implicit grant from inject_into_field)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port, { allowedActions: ["inject_into_field"] });
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "action_not_allowed");
  });
});

test("refuses if blind mode is already active (no clobber)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.blind.start("vercel.com", "other");
    const g = services.approvals.create({ ...bindingFor(), });
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "blind_mode_already_active");
  });
});

test("submit handle on a DIFFERENT target is fail-closed (handle_target_mismatch)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.handles.put({
      label: "submit-btn", target_id: "T-OTHER", domain: "vercel.com", page_url_host: "vercel.com",
      page_title: "Proj", backend_node_id: 22, handle_fingerprint: "sha256:submit", element_kind: "button",
    });
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_target_mismatch");
  });
});

test("submit handle on a DIFFERENT domain is fail-closed (handle_target_mismatch)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    services.handles.put({
      label: "submit-btn", target_id: "T-1", domain: "evil.example.com", page_url_host: "evil.example.com",
      page_title: "Proj", backend_node_id: 22, handle_fingerprint: "sha256:submit", element_kind: "button",
    });
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_target_mismatch");
  });
});

function bindingFor(over: Record<string, unknown> = {}) {
  return {
    action: "inject_submit" as const, ref: "ss://stripe/prod/WH", environment: "production",
    destination_domain: "vercel.com", target_id: "T-1", field_fingerprint: "sha256:field",
    template_id: null, template_params: null, allowed_domains: ["vercel.com"],
    submit_fingerprint: "sha256:submit", success_condition: "Environment Variable Added",
    auto_resume: true, field_handle_label: "value-field", submit_handle_label: "submit-btn",
    ...over,
  };
}

test("success + absence proof passed → blind_mode:false, submitted:true, and a blind_auto_resume audit record", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ observeText: async () => true, proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);
    assert.equal((r.body as { absence_proof: string }).absence_proof, "passed");
    assert.equal((r.body as { success_signal: string }).success_signal, "text_matched");
    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), true);
    assert.equal(log.includes(SECRET), false);
  });
});

test("success observed but absence inconclusive → stays blind, manual_recovery_required, no auto-resume audit", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ observeText: async () => true, proveAbsence: async () => ({ passed: false }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.equal("success_signal" in r.body, false);
    assert.equal("absence_proof" in r.body, false);
    assert.notEqual(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("pre-write handle revalidation failure (post-approval) ends blind and errors — safe, nothing written", async () => {
  await withDaemon(async ({ port, services }) => {
    let calls = 0;
    services.browser = stub({
      revalidateHandle: async () => { calls += 1; if (calls > 2) throw new ShuttleError("handle_invalid", "gone"); },
    });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_invalid");
    assert.equal(services.blind.current(), null); // blind ended (safe — pre-write)
  });
});

test("post-write failure (click throws) keeps blind active and returns submitted:unknown", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({ clickBackendNode: async () => { throw new Error("click boom"); } });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.notEqual(services.blind.current(), null);
  });
});

test("a HUNG inject/click (no throw, never resolves) fails closed within the deadline — blind stays active", async () => {
  const prevD = process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS;
  process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS = "200";
  try {
    await withDaemon(async ({ port, services }) => {
      services.browser = stub({ clickBackendNode: async () => { await new Promise<void>(() => {}); } }); // never resolves, never throws
      await setup(services, port);
      const g = services.approvals.create(bindingFor());
      services.approvals.approve(g.id);
      const started = Date.now();
      const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
      assert.ok(Date.now() - started < 5_000, "must fail closed at ~the deadline, not hang");
      assert.equal(r.status, 200);
      assert.equal((r.body as { submitted: unknown }).submitted, "unknown");
      assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
      assert.equal((r.body as { next: string }).next, "manual_recovery_required");
      assert.notEqual(services.blind.current(), null);
    });
  } finally {
    if (prevD === undefined) delete process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS;
    else process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS = prevD;
  }
});

test("no raw secret and no observed text appears in any response", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    const s = JSON.stringify(r.body);
    assert.equal(s.includes(SECRET), false);
  });
});
