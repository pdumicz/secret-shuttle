import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getShuttlePaths } from "../shared/config.js";
import { DaemonServer } from "../daemon/server.js";
import { DaemonServices } from "../daemon/services.js";
import { registerRoutes } from "../daemon/api/router.js";
import type { BrowserOps } from "../daemon/chrome/internal-ops.js";

const SECRET = "whsec_e2e_revealed_value_must_not_leak";

function stubBrowser(): BrowserOps {
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
  };
}

test("agentic reveal-capture end-to-end leaks neither the raw secret in any response nor any observed page text", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-e2e-rc-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));

  const call = async (method: string, p: string, b?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { Authorization: "Bearer t", "content-type": "application/json" },
      ...(b !== undefined ? { body: JSON.stringify(b) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const responses: { status: number; body: Record<string, unknown> }[] = [];

  try {
    services.browser = stubBrowser();
    responses.push(await call("POST", "/v1/unlock", { passphrase: "p", set_passphrase: true }));
    // Agent marks reveal + container + hide BEFORE blind mode (Phase 1 surface).
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

    const g = services.approvals.create({
      action: "reveal_capture", ref: null, planned_ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
      environment: "production", destination_domain: "dashboard.stripe.com", target_id: "T-1",
      field_fingerprint: null, template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com"],
      reveal_fingerprint: "sha256:reveal", hide_fingerprint: "sha256:hide",
      container_fingerprint: "sha256:container", capture_mode: "container",
      auto_resume: true, reveal_handle_label: "reveal-button",
      hide_handle_label: "hide-button", container_handle_label: "secret-card",
    });
    services.approvals.approve(g.id);
    const r = await call("POST", "/v1/secrets/reveal-capture", {
      name: "STRIPE_WEBHOOK_SECRET", environment: "production", source: "stripe",
      domain: "dashboard.stripe.com", reveal_handle: "reveal-button",
      container_handle: "secret-card", hide_handle: "hide-button",
      allowed_domains: ["dashboard.stripe.com"], approval_id: g.id, wait_for_approval: false,
    });
    responses.push(r);
    assert.equal(r.status, 200);
    assert.equal((r.body as { captured: unknown }).captured, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);
    assert.equal((r.body as { value_visible_to_agent: boolean }).value_visible_to_agent, false);

    responses.push(await call("GET", "/v1/status"));
    responses.push(await call("POST", "/v1/secrets/list", {}));

    for (const resp of responses) {
      const s = JSON.stringify(resp.body);
      assert.equal(s.includes(SECRET), false, `raw secret leaked: ${s}`);
    }
    const auditLog = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    assert.equal(auditLog.includes(SECRET), false, "raw secret leaked into the on-disk audit log");
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
});
