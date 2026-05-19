import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "../api/router.js";

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-uij-"));
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

test("the UI grant JSON serializes the inject_submit display + match fields (real values, not ?)", async () => {
  await withDaemon(async ({ port, services }) => {
    const g = services.approvals.create({
      action: "inject_submit", ref: "ss://stripe/prod/WH", environment: "production",
      destination_domain: "vercel.com", target_id: "T-1", field_fingerprint: "sha256:field",
      template_id: null, template_params: null, allowed_domains: ["vercel.com"],
      submit_fingerprint: "sha256:submit", success_condition: "Environment Variable Added",
      auto_resume: true, field_handle_label: "value-field", submit_handle_label: "submit-btn",
    });
    const res = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.field_handle_label, "value-field");
    assert.equal(j.submit_handle_label, "submit-btn");
    assert.equal(j.success_condition, "Environment Variable Added");
    assert.equal(j.submit_fingerprint, "sha256:submit");
  });
});

test("the UI grant JSON serializes allowed_actions for a generate grant", async () => {
  await withDaemon(async ({ port, services }) => {
    const g = services.approvals.create({
      action: "generate", ref: null, planned_ref: "ss://local/dev/K", environment: "development",
      destination_domain: null, target_id: null, field_fingerprint: null,
      template_id: null, template_params: null, allowed_domains: [],
      allowed_actions: ["inject_into_field", "inject_submit"],
    });
    const res = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    const j = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(j.allowed_actions, ["inject_into_field", "inject_submit"]);
  });
});
