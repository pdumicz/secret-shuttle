import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapStore } from "./store.js";
import { executeBatch, type ExecutorDeps } from "./executor.js";
import { ShuttleError } from "../../shared/errors.js";

async function setupStore(): Promise<BootstrapStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-exec-"));
  return new BootstrapStore({ rootDir: dir });
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  // Default core functions return success.
  const generateOk = async () => ({ generated: true, secret_ref: "ss://local/prod/X", name: "X", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const });
  const revealOk = async () => ({ captured: true, secret_ref: "ss://local/prod/X", fingerprint: "fp", absence_proof: "passed" as const, blind_mode: false as const, value_visible_to_agent: false as const });
  const templateOk = async () => ({ executed: true, template_id: "vercel-env-add", secret_ref: "ss://local/prod/X", binary_path: null, binary_sha256: null, exit_code: 0, value_visible_to_agent: false as const });
  return {
    generateSecret: generateOk as any,
    revealCapture: revealOk as any,
    runTemplate: templateOk as any,
    services: {} as any,
    daemonPortRef: () => 9876,
    ...overrides,
  };
}

test("executeBatch: completes all steps for a 1-secret 1-destination plan", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "b1",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: { name: "API_KEY", environment: "production" },
        domain: "vercel.com",
      }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  const result = await executeBatch(store, "b1", makeDeps());

  assert.strictEqual(result.completed, 1);
  assert.strictEqual(result.failed, 0);
  const final = await store.get("b1");
  assert.strictEqual(final?.status, "completed");
});

test("executeBatch: partial-success records per-step errors", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "b2",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [
      { secret: "OK_KEY", ref: "ss://local/prod/OK_KEY", source: { kind: "random_32_bytes" }, destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }] },
      { secret: "BAD_KEY", ref: "ss://local/prod/BAD_KEY", source: { kind: "random_32_bytes" }, destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  let callCount = 0;
  const result = await executeBatch(store, "b2", makeDeps({
    runTemplate: async () => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error("simulated push failure");
      }
      return { executed: true, template_id: "vercel-env-add", secret_ref: "ss://local/prod/OK_KEY", binary_path: null, binary_sha256: null, exit_code: 0, value_visible_to_agent: false as const };
    },
  }));

  assert.strictEqual(result.completed, 1);
  assert.strictEqual(result.failed, 1);
  const final = await store.get("b2");
  assert.strictEqual(final?.status, "failed_partial");
});

test("executeBatch: re-run skips completed steps (idempotent)", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "b3",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: { API_KEY: { ok: true, ref: "ss://local/prod/API_KEY" } }, // already done
    created_at: Date.now(),
    status: "in_progress",
  });

  let coreCalled = 0;
  await executeBatch(store, "b3", makeDeps({
    generateSecret: async () => { coreCalled++; return { generated: true, secret_ref: "ss://local/prod/API_KEY", name: "API_KEY", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; },
  }));

  assert.strictEqual(coreCalled, 0, "completed step must not be re-executed");
});

test("executeBatch: unknown batch throws bootstrap_batch_not_found", async () => {
  const store = await setupStore();
  await assert.rejects(
    executeBatch(store, "missing", makeDeps()),
    (e: unknown) => e instanceof ShuttleError && e.code === "bootstrap_batch_not_found",
  );
});

test("executeBatch: already-completed batch returns cached result without re-running", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "done",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: { API_KEY: { ok: true, ref: "ss://local/prod/API_KEY" } },
    created_at: Date.now(),
    status: "completed",
  });

  let coreCalled = 0;
  const result = await executeBatch(store, "done", makeDeps({
    generateSecret: async () => { coreCalled++; return { generated: true, secret_ref: "ss://local/prod/X", name: "API_KEY", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; },
    runTemplate: async () => { coreCalled++; return { executed: true, template_id: "t", secret_ref: "ss://local/prod/X", binary_path: null, binary_sha256: null, exit_code: 0, value_visible_to_agent: false as const }; },
  }));

  assert.strictEqual(coreCalled, 0, "completed batch must not re-execute");
  assert.strictEqual(result.completed, 1);
});

test("executeBatch: capture source calls revealCapture core", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "cap",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "STRIPE",
      ref: "ss://local/prod/STRIPE",
      source: { kind: "capture", url: "https://stripe.com" },
      destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  let revealCalled = false;
  const result = await executeBatch(store, "cap", makeDeps({
    revealCapture: async () => { revealCalled = true; return { captured: true, secret_ref: "ss://local/prod/STRIPE", fingerprint: "fp", absence_proof: "passed" as const, blind_mode: false as const, value_visible_to_agent: false as const }; },
  }));

  assert.strictEqual(revealCalled, true);
  assert.strictEqual(result.completed, 1);
});

test("executeBatch: non-zero template exit_code marks destination as failed", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "exitcode",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: {},
        domain: "vercel.com",
      }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  const result = await executeBatch(store, "exitcode", makeDeps({
    runTemplate: async () => ({
      executed: false,
      template_id: "vercel-env-add",
      secret_ref: "ss://local/prod/API_KEY",
      binary_path: null,
      binary_sha256: null,
      exit_code: 1,
      value_visible_to_agent: false as const,
    }),
  }));

  assert.strictEqual(result.completed, 0);
  assert.strictEqual(result.failed, 1);
  const final = await store.get("exitcode");
  assert.strictEqual(final?.status, "failed_partial");
  const stepResult = final?.step_results["API_KEY"];
  assert.strictEqual(stepResult?.ok, false);
  // Step-level error_code is "destination_partial_failure" (inherited from the
  // anyDestFailed branch in executeBatch), but the destination-level result
  // must carry the template_exec_failed code so retries/triage can see why.
  const destResult = stepResult?.destinations_pushed?.[0];
  assert.strictEqual(destResult?.ok, false);
  assert.strictEqual(destResult?.error_code, "template_exec_failed");
  assert.match(destResult?.message ?? "", /exit.*1/i);
});

test("executeBatch: PlanEntry.force=true propagates to generateSecret input", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "force",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: {},
        domain: "vercel.com",
      }],
      force: true,
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  let observedForce: unknown = "unset";
  await executeBatch(store, "force", makeDeps({
    generateSecret: async (_s, _p, input) => {
      observedForce = (input as { force?: boolean }).force;
      return { generated: true, secret_ref: "ss://local/prod/API_KEY", name: "API_KEY", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const };
    },
  }));
  assert.strictEqual(observedForce, true, "executor must propagate entry.force to generateSecret input");
});

test("executeBatch: PlanEntry.force=undefined → generateSecret input has no force key", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "noforce",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: {},
        domain: "vercel.com",
      }],
      // force omitted
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  let observedKeys: string[] = [];
  await executeBatch(store, "noforce", makeDeps({
    generateSecret: async (_s, _p, input) => {
      observedKeys = Object.keys(input as unknown as Record<string, unknown>);
      return { generated: true, secret_ref: "ss://local/prod/API_KEY", name: "API_KEY", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const };
    },
  }));
  assert.strictEqual(observedKeys.includes("force"), false, "force key must be absent when entry.force is undefined");
});

test("executeBatch: existing source skips source step", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "ex",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "FOO",
      ref: "ss://upstream/prod/FOO",
      source: { kind: "existing", ref: "ss://upstream/prod/FOO" },
      destinations: [{ shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  });

  let generateCalled = false;
  let revealCalled = false;
  const result = await executeBatch(store, "ex", makeDeps({
    generateSecret: async () => { generateCalled = true; return { generated: true, secret_ref: "x", name: "FOO", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; },
    revealCapture: async () => { revealCalled = true; return { captured: true, secret_ref: "x", fingerprint: "fp", absence_proof: "passed" as const, blind_mode: false as const, value_visible_to_agent: false as const }; },
  }));

  assert.strictEqual(generateCalled, false);
  assert.strictEqual(revealCalled, false);
  assert.strictEqual(result.completed, 1);
});
