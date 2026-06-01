import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../daemon/server.js";
import { DaemonServices } from "../daemon/services.js";
import { registerRoutes } from "../daemon/api/router.js";
import type { BrowserOps, CaptureResult } from "../daemon/chrome/internal-ops.js";

function stubBrowser(state: { domain: string; target: string; value: string }): BrowserOps {
  const field = { tag: "input", editable: true };
  const fingerprint = `sha256:${state.target}-${state.domain}`;
  const make = (): CaptureResult => ({
    value: state.value, domain: state.domain, target_id: state.target, field, field_fingerprint: fingerprint,
  });
  return {
    available: true,
    captureFocused: async () => make(),
    captureSelection: async () => make(),
    injectFocused: async () => ({ domain: state.domain, target_id: state.target, field, field_fingerprint: fingerprint }),
    readFocusedFingerprintAndDomain: async () => {
      const c = make();
      const { value: _v, ...rest } = c;
      return rest;
    },
    currentDomainAndTarget: async () => ({ domain: state.domain, target_id: state.target }),
    markFocused: async () => ({
      target_id: state.target, domain: state.domain, page_url_host: state.domain,
      page_title: "stub", backend_node_id: 1, handle_fingerprint: "sha256:stub", element_kind: "field" as const,
    }),
    markPick: async () => ({
      target_id: state.target, domain: state.domain, page_url_host: state.domain,
      page_title: "stub", backend_node_id: 2, handle_fingerprint: "sha256:stubpick", element_kind: "button" as const,
    }),
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => ({ domain: state.domain, target_id: state.target, field, field_fingerprint: fingerprint }),
    clickBackendNode: async () => undefined,
    readBackendNodeValue: async () => "stub_value",
    baselineCandidates: async () => ({ entries: [], readableFps: [], observable: "" }),
    resolveWithinContainer: async () => ({ value: "stub_value" }),
    resolveSelectorToHandle: async () => { throw new Error("unused"); },
    selectorMatchCount: async () => 0,
    waitForSelector: async () => false,
    documentHost: async () => "stub.test",
  };
}

test("Stripe→Vercel end-to-end through daemon API with no raw secret in any response", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-e2e-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const STRIPE_SIM = "whsec_simulated_value_must_not_leak";
  const responses: { status: number; body: Record<string, unknown> }[] = [];

  try {
    // 1. Unlock the vault (create new envelope).
    responses.push(await call("POST", "/v1/unlock", { passphrase: "p", set_passphrase: true }));

    // 2. Stripe: start blind mode and capture.
    services.browser = stubBrowser({ domain: "dashboard.stripe.com", target: "T-stripe", value: STRIPE_SIM });
    responses.push(await call("POST", "/v1/blind/start", { domain: "dashboard.stripe.com", reason: "e2e" }));

    // 2a. Without approval, the capture should fail with approval_required.
    const noApproval = await call("POST", "/v1/secrets/capture", {
      name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
      allowed_domains: ["dashboard.stripe.com", "vercel.com"],
      wait_for_approval: false,
    });
    responses.push(noApproval);
    assert.equal(noApproval.status, 400);
    assert.equal((noApproval.body as { error: { code: string } }).error.code, "approval_required");

    // 2b. Issue a programmatic approval bound to the exact context, then capture.
    const captureGrant = services.approvals.create({
      action: "capture", ref: null, planned_ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      environment: "production", destination_domain: "dashboard.stripe.com",
      target_id: "T-stripe", field_fingerprint: "sha256:T-stripe-dashboard.stripe.com",
      template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com", "vercel.com"],
    });
    services.approvals.approve(captureGrant.id);
    const captureOk = await call("POST", "/v1/secrets/capture", {
      name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
      allowed_domains: ["dashboard.stripe.com", "vercel.com"],
      approval_id: captureGrant.id, wait_for_approval: false,
    });
    responses.push(captureOk);
    assert.equal(captureOk.status, 200);
    assert.equal((captureOk.body as { captured: boolean }).captured, true);
    assert.equal((captureOk.body as { secret_ref: string }).secret_ref, "ss://stripe/prod/STRIPE_WEBHOOK_SECRET");

    // 2c. End blind mode after capture — requires human approval gate.
    const blindEndGrant = services.approvals.create({
      action: "blind_end", ref: null, environment: "blind",
      destination_domain: "dashboard.stripe.com", target_id: null,
      field_fingerprint: null, template_id: null, template_params: null,
    });
    services.approvals.approve(blindEndGrant.id);
    responses.push(await call("POST", "/v1/blind/end", { approval_id: blindEndGrant.id, wait_for_approval: false }));

    // 3. Vercel: navigate (simulated), inject with a new approval.
    services.browser = stubBrowser({ domain: "vercel.com", target: "T-vercel", value: "" });
    const injectGrant = services.approvals.create({
      action: "inject", ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      environment: "production", destination_domain: "vercel.com",
      target_id: "T-vercel", field_fingerprint: "sha256:T-vercel-vercel.com",
      template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com", "vercel.com"],
    });
    services.approvals.approve(injectGrant.id);
    const injectOk = await call("POST", "/v1/secrets/inject", {
      ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      domain: "vercel.com",
      approval_id: injectGrant.id, wait_for_approval: false,
    });
    responses.push(injectOk);
    assert.equal(injectOk.status, 200);
    assert.equal((injectOk.body as { injected: boolean }).injected, true);
    assert.equal((injectOk.body as { browser_domain: string }).browser_domain, "vercel.com");

    // Daemon-managed blind window: a successful inject leaves blind mode ACTIVE.
    const blindAfterInject = await call("GET", "/v1/status");
    responses.push(blindAfterInject);
    assert.notEqual((blindAfterInject.body as { blind_mode: unknown }).blind_mode, null);

    // Resume observation via a human-approved blind end (bound to the inject domain).
    const injectBlindEndGrant = services.approvals.create({
      action: "blind_end", ref: null, environment: "blind",
      destination_domain: "vercel.com", target_id: null,
      field_fingerprint: null, template_id: null, template_params: null,
    });
    services.approvals.approve(injectBlindEndGrant.id);
    const resumed = await call("POST", "/v1/blind/end", { approval_id: injectBlindEndGrant.id, wait_for_approval: false });
    responses.push(resumed);
    assert.equal(resumed.status, 200);
    const blindCleared = await call("GET", "/v1/status");
    responses.push(blindCleared);
    assert.equal((blindCleared.body as { blind_mode: unknown }).blind_mode, null);

    // 4. The agent should be able to inspect metadata (no value).
    const inspect = await call("POST", "/v1/secrets/inspect", { ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET" });
    responses.push(inspect);
    assert.equal(inspect.status, 200);
    assert.equal((inspect.body as { value_visible_to_agent: boolean }).value_visible_to_agent, false);

    // 5. Inject mismatch: an attempt with a stale approval against a different target should fail.
    const wrongGrant = services.approvals.create({
      action: "inject", ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      environment: "production", destination_domain: "evil.example.com",
      target_id: "T-other", field_fingerprint: "sha256:T-other-evil.example.com",
      template_id: null, template_params: null,
    });
    services.approvals.approve(wrongGrant.id);
    const wrongInject = await call("POST", "/v1/secrets/inject", {
      ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      domain: "vercel.com",
      approval_id: wrongGrant.id, wait_for_approval: false,
    });
    responses.push(wrongInject);
    assert.equal(wrongInject.status, 400);
    assert.equal((wrongInject.body as { error: { code: string } }).error.code, "approval_mismatch");

    // CRITICAL: No raw simulated secret leaks anywhere in any response body.
    for (const r of responses) {
      const s = JSON.stringify(r.body);
      assert.equal(s.includes(STRIPE_SIM), false, `Raw secret leaked in response: ${s}`);
    }
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    await rm(home, { recursive: true, force: true });
  }
});
