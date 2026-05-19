import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { registerRoutes } from "../api/router.js";

async function withDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-uijr-"));
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

test("the UI grant JSON serializes the reveal_capture display + match fields (real values, not ?)", async () => {
  await withDaemon(async ({ port, services }) => {
    const g = services.approvals.create({
      action: "reveal_capture", ref: null, planned_ref: "ss://stripe/prod/WH",
      environment: "production", destination_domain: "dashboard.stripe.com",
      target_id: "T-1", field_fingerprint: null, template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com"],
      reveal_fingerprint: "sha256:reveal", hide_fingerprint: "sha256:hide",
      container_fingerprint: "sha256:container", capture_mode: "container",
      auto_resume: true, reveal_handle_label: "reveal-button",
      hide_handle_label: "hide-button", container_handle_label: "secret-card",
    });
    const res = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.reveal_handle_label, "reveal-button");
    assert.equal(j.hide_handle_label, "hide-button");
    assert.equal(j.container_handle_label, "secret-card");
    assert.equal(j.reveal_fingerprint, "sha256:reveal");
    assert.equal(j.hide_fingerprint, "sha256:hide");
    assert.equal(j.container_fingerprint, "sha256:container");
    assert.equal(j.capture_mode, "container");
  });
});

test("the UI grant JSON keeps the absent reveal_capture optionals as null (no-hide-handle / field mode)", async () => {
  await withDaemon(async ({ port, services }) => {
    const g = services.approvals.create({
      action: "reveal_capture", ref: null, planned_ref: "ss://stripe/prod/WH",
      environment: "production", destination_domain: "dashboard.stripe.com",
      target_id: "T-1", field_fingerprint: "sha256:thefield", template_id: null, template_params: null,
      allowed_domains: ["dashboard.stripe.com"],
      reveal_fingerprint: "sha256:reveal", capture_mode: "field",
      auto_resume: true, reveal_handle_label: "reveal-button", field_handle_label: "secret-field",
    });
    const res = await fetch(`http://127.0.0.1:${port}/ui/approvals/${g.id}?token=${g.ui_token}`);
    const j = (await res.json()) as Record<string, unknown>;
    assert.equal(j.capture_mode, "field");
    assert.equal(j.field_fingerprint, "sha256:thefield");
    assert.equal(j.hide_fingerprint, null);
    assert.equal(j.container_fingerprint, null);
    assert.equal(j.hide_handle_label, null);
    assert.equal(j.container_handle_label, null);
  });
});
