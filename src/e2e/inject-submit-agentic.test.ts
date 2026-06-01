import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../daemon/server.js";
import { DaemonServices } from "../daemon/services.js";
import { registerRoutes } from "../daemon/api/router.js";
import { SecretValue } from "../vault/secret-value.js";
import type { BrowserOps } from "../daemon/chrome/internal-ops.js";

const SECRET = "whsec_e2e_simulated_value_must_not_leak";
const SUCCESS_TEXT = "Environment Variable Added";

function stubBrowser(): BrowserOps {
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
    resolveSelectorToHandle: async () => { throw new Error("unused"); },
    selectorMatchCount: async () => 0,
    waitForSelector: async () => false,
    documentHost: async () => "stub.test",
  };
}

test("agentic inject-submit end-to-end leaks neither the raw secret nor observed success text", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-e2e-is-"));
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
    await services.vault.upsertSecret({
      name: "WH", environment: "production", source: "stripe", value: SecretValue.fromUtf8(SECRET), allowedDomains: ["vercel.com"],
    });
    // Agent marks the field + submit BEFORE blind mode (Phase 1 surface).
    services.handles.put({
      label: "value-field", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
      page_title: "Proj", backend_node_id: 11, handle_fingerprint: "sha256:field", element_kind: "field",
    });
    services.handles.put({
      label: "submit-btn", target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
      page_title: "Proj", backend_node_id: 22, handle_fingerprint: "sha256:submit", element_kind: "button",
    });

    const g = services.approvals.create({
      action: "inject_submit", ref: "ss://stripe/prod/WH", environment: "production",
      destination_domain: "vercel.com", target_id: "T-1", field_fingerprint: "sha256:field",
      template_id: null, template_params: null, allowed_domains: ["vercel.com"],
      submit_fingerprint: "sha256:submit", success_condition: SUCCESS_TEXT, auto_resume: true,
      field_handle_label: "value-field", submit_handle_label: "submit-btn",
    });
    services.approvals.approve(g.id);
    const r = await call("POST", "/v1/secrets/inject-submit", {
      ref: "ss://stripe/prod/WH", domain: "vercel.com",
      field_handle: "value-field", submit_handle: "submit-btn",
      success_text: SUCCESS_TEXT, approval_id: g.id, wait_for_approval: false,
    });
    responses.push(r);
    assert.equal(r.status, 200);
    assert.equal((r.body as { submitted: unknown }).submitted, true);
    assert.equal((r.body as { blind_mode: boolean }).blind_mode, false);

    responses.push(await call("GET", "/v1/status"));

    for (const resp of responses) {
      const s = JSON.stringify(resp.body);
      assert.equal(s.includes(SECRET), false, `raw secret leaked: ${s}`);
      assert.equal(s.includes(SUCCESS_TEXT), false, `observed success text leaked: ${s}`);
    }
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
});
