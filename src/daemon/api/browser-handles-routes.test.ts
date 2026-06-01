import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "./router.js";
import type { BrowserOps, HandleDescriptor } from "../chrome/internal-ops.js";

function stub(desc: Partial<HandleDescriptor> = {}): BrowserOps {
  const base: HandleDescriptor = {
    target_id: "T-1", domain: "vercel.com", page_url_host: "vercel.com",
    page_title: "Proj", backend_node_id: 7, handle_fingerprint: "sha256:fp", element_kind: "button",
    ...desc,
  };
  return {
    available: true,
    captureFocused: async () => { throw new Error("unused"); },
    captureSelection: async () => { throw new Error("unused"); },
    injectFocused: async () => { throw new Error("unused"); },
    readFocusedFingerprintAndDomain: async () => { throw new Error("unused"); },
    currentDomainAndTarget: async () => ({ domain: base.domain, target_id: base.target_id }),
    markFocused: async () => base,
    markPick: async () => ({ ...base, backend_node_id: 9, element_kind: "field" }),
    revalidateHandle: async () => undefined,
    observeText: async () => true,
    proveAbsence: async () => ({ passed: true }),
    injectIntoBackendNode: async () => ({ domain: base.domain, target_id: base.target_id, field: { tag: "input", editable: true }, field_fingerprint: base.handle_fingerprint }),
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

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-bh-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(port: number, method: string, p: string, body?: unknown) {
  const init: RequestInit = { method, headers: { Authorization: "Bearer t", "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("mark focused stores a handle; marks lists non-secret metadata only", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    const m = await call(port, "POST", "/v1/browser/mark", { how: "focused", label: "submit" });
    assert.equal(m.status, 200);
    assert.equal((m.body as { marked: boolean }).marked, true);
    assert.equal((m.body as { label: string }).label, "submit");
    assert.equal((m.body as { value_visible_to_agent: boolean }).value_visible_to_agent, false);
    assert.equal("handle_fingerprint" in m.body, false); // never exposed
    assert.equal("backend_node_id" in m.body, false);

    const list = await call(port, "POST", "/v1/browser/marks");
    assert.equal(list.status, 200);
    const marks = (list.body as { marks: Record<string, unknown>[] }).marks;
    assert.equal(marks.length, 1);
    assert.deepEqual(Object.keys(marks[0]!).sort(),
      ["created_at", "domain", "element_kind", "expires_at", "label", "page_url_host", "valid"]);
  });
});

test("mark requires a started browser", async () => {
  await withDaemon(async ({ port }) => {
    const m = await call(port, "POST", "/v1/browser/mark", { how: "focused", label: "x" });
    assert.equal(m.status, 400);
    assert.equal((m.body as { error: { code: string } }).error.code, "browser_not_started");
  });
});

test("mark is rejected while blind mode is active", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    services.blind.start("vercel.com", "test");
    const m = await call(port, "POST", "/v1/browser/mark", { how: "focused", label: "x" });
    assert.equal(m.status, 400);
    assert.equal((m.body as { error: { code: string } }).error.code, "blind_mode_active");
  });
});

test("invalid `how` is a bad request", async () => {
  await withDaemon(async ({ port, services }) => {
    services.browser = stub();
    const m = await call(port, "POST", "/v1/browser/mark", { how: "selector", label: "x" });
    assert.equal(m.status, 400);
    assert.equal((m.body as { error: { code: string } }).error.code, "bad_request");
  });
});

test("marks reports valid:false when revalidation fails, with no detail leaked", async () => {
  await withDaemon(async ({ port, services }) => {
    const failing: BrowserOps = {
      ...stub(),
      revalidateHandle: async () => { throw new Error("handle drifted to another node"); },
    };
    services.browser = failing;
    const m = await call(port, "POST", "/v1/browser/mark", { how: "focused", label: "submit" });
    assert.equal(m.status, 200);
    const list = await call(port, "POST", "/v1/browser/marks");
    assert.equal(list.status, 200);
    const marks = (list.body as { marks: Record<string, unknown>[] }).marks;
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.valid, false);
    assert.equal(JSON.stringify(list.body).includes("drifted"), false);
    assert.deepEqual(Object.keys(marks[0]!).sort(),
      ["created_at", "domain", "element_kind", "expires_at", "label", "page_url_host", "valid"]);
  });
});
