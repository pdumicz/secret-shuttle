import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapStore } from "./store.js";
import { assertBootstrapAuthorityValid } from "./authority.js";
import { ShuttleError } from "../../shared/errors.js";

test("assertBootstrapAuthorityValid: in_progress batch passes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-auth-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save({
    batch_id: "x",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "in_progress",
  });
  await assertBootstrapAuthorityValid({ batchId: "x" }, store);
});

test("assertBootstrapAuthorityValid: pending batch -> throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-auth-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save({
    batch_id: "y",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });
  await assert.rejects(
    assertBootstrapAuthorityValid({ batchId: "y" }, store),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_batch_not_found",
  );
});

test("assertBootstrapAuthorityValid: unknown batch -> throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-auth-"));
  const store = new BootstrapStore({ rootDir: dir });
  await assert.rejects(
    assertBootstrapAuthorityValid({ batchId: "missing" }, store),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_batch_not_found",
  );
});

test("assertBootstrapAuthorityValid: completed batch -> throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-auth-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save({
    batch_id: "done",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "completed",
  });
  await assert.rejects(
    assertBootstrapAuthorityValid({ batchId: "done" }, store),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_batch_not_found",
  );
});
