// src/daemon/audit-fields-bootstrap-step.test.ts
//
// Burst 5 §4 — Task 4.2 regression: bootstrap_step audit rows must carry
// the new durable fields (batch_id, source_kind, destination_shorthands,
// destinations_ok_count, destinations_failed_count). Test exercises
// `executeBatch` against a minimal in-memory plan and asserts the
// audit log line shape.
//
// We bypass the capture branch entirely by using a `random_32_bytes` source
// plus a stubbed generateSecret/runTemplate — this avoids needing a real
// CDP transport while still routing through the same writeDaemonAudit calls
// that production hits for source: random_*.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { encryptVault } from "../vault/crypto.js";
import { DaemonServices } from "./services.js";
import { BootstrapStore } from "./bootstrap/store.js";
import { executeBatch, type ExecutorDeps } from "./bootstrap/executor.js";

interface AuditRow {
  ts: string;
  action: string;
  ok: boolean;
  ref?: string;
  batch_id?: string;
  source_kind?: string;
  destination_shorthands?: string[];
  destinations_ok_count?: number;
  destinations_failed_count?: number;
  error_code?: string;
}

async function readAuditRows(homeDir: string): Promise<AuditRow[]> {
  const raw = await readFile(path.join(homeDir, "audit.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRow);
}

async function setupHome(): Promise<{ homeDir: string; cleanup: () => Promise<void>; services: DaemonServices; store: BootstrapStore }> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ss-audit-step-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = homeDir;

  // Initialize an unlocked vault so vault.upsertSecret / vault.markUsed
  // (called by generateSecret stub indirectly via the test plan) can land.
  // The executor itself doesn't touch the vault for random_* sources — the
  // generateSecret dep does — so we keep the vault available defensively.
  const masterKey = randomBytes(32);
  const initialPlaintext = {
    version: 1 as const,
    secrets: [] as never[],
    fingerprint_key: randomBytes(32).toString("base64"),
  };
  const cipher = encryptVault(initialPlaintext, masterKey);
  await writeFile(path.join(homeDir, "vault.json.enc"), JSON.stringify(cipher), { mode: 0o600 });

  const services = new DaemonServices();
  services.lock.unlock(masterKey);
  const store = new BootstrapStore({ rootDir: path.join(homeDir, "bootstrap-batches") });

  const cleanup = async (): Promise<void> => {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(homeDir, { recursive: true, force: true });
  };
  return { homeDir, cleanup, services, store };
}

function makeDeps(services: DaemonServices, runTemplateExitCode = 0): ExecutorDeps {
  return {
    generateSecret: (async (_s, _p, input, _o) => ({
      generated: true,
      secret_ref: `ss://local/production/${input.name}`,
      name: input.name,
      environment: "production",
      fingerprint: "fp",
      value_visible_to_agent: false as const,
    })) as ExecutorDeps["generateSecret"],
    revealCapture: (async () => { throw new Error("not used"); }) as ExecutorDeps["revealCapture"],
    runTemplate: (async (_s, _p, input, _o) => ({
      executed: runTemplateExitCode === 0,
      template_id: input.templateId,
      secret_ref: input.ref,
      binary_path: null,
      binary_sha256: null,
      exit_code: runTemplateExitCode,
      value_visible_to_agent: false as const,
    })) as ExecutorDeps["runTemplate"],
    services,
    daemonPortRef: () => 9876,
  };
}

test("bootstrap_step audit row (success): carries batch_id, source_kind, destination_shorthands, ok/failed counts", async (t) => {
  const { homeDir, cleanup, services, store } = await setupHome();
  t.after(cleanup);

  const batchId = "b-audit-step-ok";
  await store.save({
    batch_id: batchId,
    approval_id: "a",
    plan_file_path: "/tmp/plan.yml",
    plan: [
      {
        secret: "STRIPE_KEY",
        ref: "ss://local/production/STRIPE_KEY",
        source: { kind: "random_32_bytes" },
        destinations: [
          { shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" },
          { shorthand: "github:production", template_id: "gh-secret-set", template_params: {}, domain: "github.com" },
        ],
      },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  await executeBatch(store, batchId, makeDeps(services));

  const rows = await readAuditRows(homeDir);
  const stepRow = rows.find((r) => r.action === "bootstrap_step");
  assert.ok(stepRow, "expected at least one bootstrap_step row");
  assert.equal(stepRow.ok, true);
  assert.equal(stepRow.batch_id, batchId);
  assert.equal(stepRow.source_kind, "random_32_bytes");
  assert.ok(Array.isArray(stepRow.destination_shorthands), "destination_shorthands must be an array");
  assert.deepEqual(stepRow.destination_shorthands, ["vercel:production", "github:production"]);
  assert.equal(stepRow.destinations_ok_count, 2);
  assert.equal(stepRow.destinations_failed_count, 0);
});

test("bootstrap_step audit row (partial failure): destinations_ok_count + destinations_failed_count reflect outcome", async (t) => {
  const { homeDir, cleanup, services, store } = await setupHome();
  t.after(cleanup);

  const batchId = "b-audit-step-partial";
  await store.save({
    batch_id: batchId,
    approval_id: "a",
    plan_file_path: "/tmp/plan.yml",
    plan: [
      {
        secret: "STRIPE_KEY",
        ref: "ss://local/production/STRIPE_KEY",
        source: { kind: "random_64_bytes" },
        destinations: [
          { shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" },
          { shorthand: "github:production", template_id: "gh-secret-set", template_params: {}, domain: "github.com" },
        ],
      },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  // All destinations fail (exit_code=1) → ok_count=0, failed_count=2.
  await executeBatch(store, batchId, makeDeps(services, /* runTemplateExitCode */ 1));

  const rows = await readAuditRows(homeDir);
  const stepRow = rows.find((r) => r.action === "bootstrap_step");
  assert.ok(stepRow, "expected at least one bootstrap_step row");
  assert.equal(stepRow.ok, false);
  assert.equal(stepRow.batch_id, batchId);
  assert.equal(stepRow.source_kind, "random_64_bytes");
  assert.deepEqual(stepRow.destination_shorthands, ["vercel:production", "github:production"]);
  assert.equal(stepRow.destinations_ok_count, 0);
  assert.equal(stepRow.destinations_failed_count, 2);
});
