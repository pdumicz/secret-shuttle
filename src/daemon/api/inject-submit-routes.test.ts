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
    readBackendNodeValue: async () => "stub_value",
    baselineCandidates: async () => ({ entries: [], readableFps: [], observable: "" }),
    resolveWithinContainer: async () => ({ value: "stub_value" }),
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

test("post-write timeout best-effort blanks all pages (orphaned/partial secret-bearing op) — blind STAYS active, fail-closed 200 unchanged", async () => {
  const prevD = process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS;
  process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS = "200";
  try {
    await withDaemon(async ({ port, services }) => {
      // Minimal recording fake satisfying ONLY the cdp.send calls blankAllPages
      // makes: Target.getTargets → one page target; Target.attachToTarget →
      // sessionId; Page.navigate → no errorText; Runtime.evaluate(location.href)
      // → "about:blank" (so blankAllPages treats the page as successfully
      // blanked); Target.detachFromTarget. Records every method called so the
      // test can assert the neutralization path actually ran. Test-only cast.
      const calls: { method: string; params?: unknown }[] = [];
      const fakeCdp = {
        send(method: string, params?: unknown): Promise<unknown> {
          calls.push({ method, params });
          if (method === "Target.getTargets") {
            return Promise.resolve({ targetInfos: [{ targetId: "T-1", type: "page" }] });
          }
          if (method === "Target.attachToTarget") return Promise.resolve({ sessionId: "S" });
          if (method === "Page.navigate") return Promise.resolve({});
          if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: "about:blank" } });
          if (method === "Target.detachFromTarget") return Promise.resolve({});
          return Promise.resolve({});
        },
      };
      // never-settling click → withDeadline(inject+click) rejects at 200ms →
      // post-write catch fires (secret may be on the page; orphaned op running).
      services.browser = stub({ clickBackendNode: () => new Promise<void>(() => {}) });
      await setup(services, port);
      services.cdp = fakeCdp as unknown as typeof services.cdp;
      const g = services.approvals.create(bindingFor());
      services.approvals.approve(g.id);
      const started = Date.now();
      const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
      assert.ok(Date.now() - started < 5_000, "completes well under a few seconds");
      assert.equal(r.status, 200);
      assert.equal((r.body as { submitted: unknown }).submitted, "unknown");
      assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
      assert.equal((r.body as { next: string }).next, "manual_recovery_required");
      assert.notEqual(services.blind.current(), null); // blind STILL active
      // Neutralization ran: blankAllPages navigated the page to about:blank.
      const nav = calls.find((c) => c.method === "Page.navigate");
      assert.notEqual(nav, undefined);
      assert.deepEqual(nav?.params, { url: "about:blank" });
    });
  } finally {
    if (prevD === undefined) delete process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS;
    else process.env.SECRET_SHUTTLE_INJECT_CLICK_DEADLINE_MS = prevD;
  }
});

test("post-write vault.markUsed failure keeps blind active and returns the fail-closed 200 (not a thrown error)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({ observeText: async () => true, proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    // Make markUsed reject AFTER a successful inject+click. The transaction
    // landed; a bookkeeping failure must NOT 4xx/throw — it must stay the
    // fail-closed 200 with blind ACTIVE (secret may be on the page).
    const realMarkUsed = services.vault.markUsed.bind(services.vault);
    let n = 0;
    services.vault.markUsed = (async (ref: string) => {
      n += 1;
      throw Object.assign(new Error("disk full"), { code: "EIO" });
      // (unreached) return realMarkUsed(ref);
    }) as typeof services.vault.markUsed;
    void realMarkUsed;
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);
    assert.equal(services.blind.current(), null); // auto-resumed: provably safe
    assert.ok(n >= 1, "markUsed was invoked");
  });
});

test("observeText:false (success marker never seen) → fail-closed 200, stays blind, no blind_auto_resume audit", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ observeText: async () => false, proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, "unknown");
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, true);
    assert.equal((r.body as { next: string }).next, "manual_recovery_required");
    assert.notEqual(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(log.includes('"blind_auto_resume"'), false);
  });
});

test("field_handle pointing at a non-field is fail-closed (handle_kind_mismatch)", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    await setup(services, port);
    // Re-mark value-field as a BUTTON (wrong kind for a field handle).
    services.handles.put({
      label: "value-field", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
      page_title: "Proj", backend_node_id: 11, handle_fingerprint: "sha256:field", element_kind: "button",
    });
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body());
    assert.equal(r.status, 400);
    assert.equal((r.body as { error: { code: string } }).error.code, "handle_kind_mismatch");
  });
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

/** Read every line of audit.jsonl and parse as JSON. Used by the session
 *  tests below to assert which audit records the route wrote. */
interface AuditLine {
  action: string;
  ok?: boolean;
  ref?: string;
  session_id?: string;
  error_code?: string;
  [k: string]: unknown;
}
async function readAuditLines(home: string): Promise<AuditLine[]> {
  const text = await readFile(getShuttlePaths(home).auditLogPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditLine);
}

test("inject-submit (5q): resolve plaintext only AFTER approval; ONE SecretValue feeds inject + proveAbsence; dispose once", async () => {
  // Burst 7 §2 (5q). Asserts the two-phase late-resolve discipline:
  // (1) the pre-approval preflight uses inspect (metadata-only), and
  //     resolveSecret is called ONLY after requireApprovals resolves;
  // (2) the SAME SecretValue instance feeds injectIntoBackendNode AND
  //     proveAbsence (multi-sink retention) — observed via bytes() called
  //     exactly twice on the single resolved instance;
  // (3) the SecretValue is disposed exactly once (outer finally), and after
  //     the route returns .bytes() throws (used-after-dispose).
  await withDaemon(async ({ port, services }) => {
    services.browser = stub({ observeText: async () => true, proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);

    const events: string[] = [];
    let resolveCount = 0;
    let bytesCount = 0;
    let disposeCount = 0;
    let injectSawSecret = false;
    let proveSawSecret = false;

    const realInspect = services.vault.inspect.bind(services.vault);
    services.vault.inspect = (async (ref: string) => {
      events.push("inspect");
      return realInspect(ref);
    }) as typeof services.vault.inspect;

    const realResolve = services.vault.resolveSecret.bind(services.vault);
    services.vault.resolveSecret = (async (ref: string) => {
      events.push("resolveSecret");
      resolveCount += 1;
      const r = await realResolve(ref);
      const realBytes = r.value.bytes.bind(r.value);
      const realDispose = r.value.dispose.bind(r.value);
      r.value.bytes = () => { bytesCount += 1; return realBytes(); };
      r.value.dispose = () => { disposeCount += 1; realDispose(); };
      return r;
    }) as typeof services.vault.resolveSecret;

    // Record that the sink received the real plaintext (proves the resolved
    // bytes reached both sinks), and that approval happened before resolve.
    const realInject = services.browser.injectIntoBackendNode.bind(services.browser);
    services.browser.injectIntoBackendNode = (async (refNode, v: string) => {
      events.push("inject");
      injectSawSecret = v === SECRET;
      return realInject(refNode, v);
    }) as typeof services.browser.injectIntoBackendNode;
    const realProve = services.browser.proveAbsence.bind(services.browser);
    services.browser.proveAbsence = (async (v: string) => {
      events.push("proveAbsence");
      proveSawSecret = v === SECRET;
      return realProve(v);
    }) as typeof services.browser.proveAbsence;

    const g = services.approvals.create(bindingFor());
    services.approvals.approve(g.id);
    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ approval_id: g.id }));
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, true);

    // (1) inspect ran in the pre-approval preflight; resolveSecret ran after.
    assert.equal(events[0], "inspect", "pre-approval preflight must use inspect (metadata-only)");
    const resolveIdx = events.indexOf("resolveSecret");
    const injectIdx = events.indexOf("inject");
    const proveIdx = events.indexOf("proveAbsence");
    assert.ok(resolveIdx > -1 && resolveIdx < injectIdx, "resolveSecret must precede the inject sink");
    assert.ok(injectIdx < proveIdx, "inject precedes proveAbsence");
    // resolveSecret resolved exactly once — a single SecretValue across both sinks.
    assert.equal(resolveCount, 1, "exactly one resolveSecret (one SecretValue across both sinks)");
    // (2) the single SecretValue's bytes() fed BOTH sinks.
    assert.equal(bytesCount, 2, "the same SecretValue.bytes() feeds inject AND proveAbsence");
    assert.equal(injectSawSecret, true, "inject sink received the resolved plaintext");
    assert.equal(proveSawSecret, true, "proveAbsence sink received the resolved plaintext");
    // (3) disposed exactly once in the outer finally.
    assert.equal(disposeCount, 1, "SecretValue disposed exactly once (outer finally)");
  });
});

test("inject-submit: matching session mints grant → audit carries session_id; sessionStore.uses incremented", async () => {
  await withDaemon(async ({ port, services, home }) => {
    services.browser = stub({ observeText: async () => true, proveAbsence: async () => ({ passed: true }) });
    await setup(services, port);
    // Mint and approve an inject-submit session covering this ref + domain.
    const sg = services.sessionStore.create({
      actions: ["inject-submit"],
      ref_glob: "ss://stripe/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    services.sessionStore.approve(sg.id);

    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ session_id: sg.id }));
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    assert.equal((r.body as { submitted: unknown }).submitted, true);

    // Audit: the most-recent inject_submit line carries session_id with ok:true.
    const lines = await readAuditLines(home);
    const isLine = [...lines].reverse().find((l) => l.action === "inject_submit");
    assert.ok(isLine, "expected at least one inject_submit audit line");
    assert.equal(isLine!.ok, true, "success audit must carry ok:true");
    assert.equal(
      isLine!.session_id,
      sg.id,
      "success audit must carry session_id of the consumed session",
    );

    // Session usage counter advanced exactly once.
    const session = services.sessionStore.get(sg.id)!;
    assert.equal(session.uses, 1, "session.uses should be incremented to 1");
  });
});

test("inject-submit: failure AFTER session mint still records session_id; uses still incremented", async () => {
  // Exploit the pre-write revalidate path: revalidateHandle succeeds on the
  // first two calls (pre-approval, BEFORE requireApproval mints the session
  // grant) and throws on the third (post-approval, pre-write). The session IS
  // minted and the use counter IS incremented; the throw lands in the outer
  // catch and the failure audit MUST carry session_id.
  await withDaemon(async ({ port, services, home }) => {
    let calls = 0;
    services.browser = stub({
      revalidateHandle: async () => {
        calls += 1;
        if (calls > 2) throw new ShuttleError("handle_invalid", "gone");
      },
    });
    await setup(services, port);
    const sg = services.sessionStore.create({
      actions: ["inject-submit"],
      ref_glob: "ss://stripe/prod/*",
      destination_domains: ["vercel.com"],
      ttl_ms: 60_000,
    });
    services.sessionStore.approve(sg.id);

    const r = await call(port, "POST", "/v1/secrets/inject-submit", body({ session_id: sg.id }));
    assert.equal(r.status, 400);
    assert.equal(
      (r.body as { error: { code: string } }).error.code,
      "handle_invalid",
      "post-mint failure must surface as handle_invalid (pre-write revalidate re-thrown)",
    );

    // Audit: the most-recent inject_submit failure line carries session_id with ok:false.
    const lines = await readAuditLines(home);
    const isLine = [...lines].reverse().find((l) => l.action === "inject_submit");
    assert.ok(isLine, "expected at least one inject_submit audit line");
    assert.equal(isLine!.ok, false, "failure audit must carry ok:false");
    assert.equal(
      isLine!.session_id,
      sg.id,
      "post-mint failure audit MUST still carry session_id (the session was charged a use)",
    );
    assert.equal(
      isLine!.error_code,
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
