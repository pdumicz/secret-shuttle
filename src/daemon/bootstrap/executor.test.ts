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
        kind: "template",
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: { name: "API_KEY", environment: "production" },
        domain: "vercel.com",
      }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
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
      { secret: "OK_KEY", ref: "ss://local/prod/OK_KEY", source: { kind: "random_32_bytes" }, destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }] },
      { secret: "BAD_KEY", ref: "ss://local/prod/BAD_KEY", source: { kind: "random_32_bytes" }, destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }] },
    ],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
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
      destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: { API_KEY: { ok: true, ref: "ss://local/prod/API_KEY" } }, // already done
    created_at: Date.now(),
    status: "in_progress",
    owner_agent_id: "daemon",
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
      destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: { API_KEY: { ok: true, ref: "ss://local/prod/API_KEY" } },
    created_at: Date.now(),
    status: "completed",
    owner_agent_id: "daemon",
  });

  let coreCalled = 0;
  const result = await executeBatch(store, "done", makeDeps({
    generateSecret: async () => { coreCalled++; return { generated: true, secret_ref: "ss://local/prod/X", name: "API_KEY", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const }; },
    runTemplate: async () => { coreCalled++; return { executed: true, template_id: "t", secret_ref: "ss://local/prod/X", binary_path: null, binary_sha256: null, exit_code: 0, value_visible_to_agent: false as const }; },
  }));

  assert.strictEqual(coreCalled, 0, "completed batch must not re-execute");
  assert.strictEqual(result.completed, 1);
});

test("executeBatch: capture source no longer routes through revealCapture dep (C11)", async () => {
  // Regression guard for the C11 refactor: prior behaviour delegated to
  // deps.revealCapture; the new behaviour runs the full capture state
  // machine inside the executor and bypasses the revealCapture dep
  // entirely. With no browserSession on services, the capture branch
  // throws the expected "no browser session" plan-invalid error, and
  // revealCapture is never called. The full state machine is covered in
  // executor-capture.test.ts.
  const store = await setupStore();
  await store.save({
    batch_id: "cap",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "STRIPE",
      ref: "ss://local/prod/STRIPE",
      source: { kind: "capture", url: "https://stripe.com" },
      destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  let revealCalled = false;
  const result = await executeBatch(store, "cap", makeDeps({
    revealCapture: async () => { revealCalled = true; return { captured: true, secret_ref: "ss://local/prod/STRIPE", fingerprint: "fp", absence_proof: "passed" as const, blind_mode: false as const, value_visible_to_agent: false as const }; },
  }));

  assert.strictEqual(revealCalled, false, "revealCapture must NOT be invoked from the executor under C11");
  // No browser session → step fails with bootstrap_plan_invalid; batch ends failed_partial.
  assert.strictEqual(result.completed, 0);
  assert.strictEqual(result.failed, 1);
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
        kind: "template",
        shorthand: "vercel:production",
        template_id: "vercel-env-add",
        template_params: {},
        domain: "vercel.com",
      }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
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
        kind: "template",
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
    owner_agent_id: "daemon",
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
        kind: "template",
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
    owner_agent_id: "daemon",
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
      destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
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

test("executeBatch: retry reuses prior ref and only re-runs failed destinations", async () => {
  const store = await setupStore();
  // Simulate a prior run that succeeded at source and at dest1 but failed dest2.
  await store.save({
    batch_id: "retry",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [
        { kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" },
        { kind: "template", shorthand: "github-actions:acme/widgets", template_id: "github-actions-secret-set", template_params: {}, domain: "github.com" },
      ],
    }],
    step_results: {
      API_KEY: {
        ok: false,
        ref: "ss://local/prod/API_KEY",
        destinations_pushed: [
          { destination: "vercel:production", ok: true },
          { destination: "github-actions:acme/widgets", ok: false, error_code: "template_exec_failed", message: "exit 1" },
        ],
        error_code: "destination_partial_failure",
      },
    },
    created_at: Date.now(),
    status: "failed_partial",
    owner_agent_id: "daemon",
  });

  let generateCalled = 0;
  const templateCalls: Array<{ id: string; ref: string }> = [];
  const result = await executeBatch(store, "retry", makeDeps({
    generateSecret: async () => {
      generateCalled += 1;
      return { generated: true, secret_ref: "ss://local/prod/API_KEY", name: "API_KEY", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const };
    },
    runTemplate: async (_s, _p, input) => {
      templateCalls.push({ id: (input as { templateId: string; ref: string }).templateId, ref: (input as { templateId: string; ref: string }).ref });
      return { executed: true, template_id: (input as { templateId: string }).templateId, secret_ref: (input as { ref: string }).ref, binary_path: null, binary_sha256: null, exit_code: 0, value_visible_to_agent: false as const };
    },
  }));

  assert.strictEqual(generateCalled, 0, "source step must not re-run when prior ref exists");
  assert.strictEqual(templateCalls.length, 1, "only the previously-failed destination must be re-attempted");
  assert.strictEqual(templateCalls[0]!.id, "github-actions-secret-set", "the retried destination must be the one that previously failed");
  assert.strictEqual(result.completed, 1);
  assert.strictEqual(result.failed, 0);
  const final = await store.get("retry");
  assert.strictEqual(final?.status, "completed");
  // Merged destinations preserve both: dest1 from prior (ok=true), dest2 from new (ok=true).
  const finalDests = final?.step_results["API_KEY"]?.destinations_pushed;
  assert.strictEqual(finalDests?.length, 2);
  assert.strictEqual(finalDests?.[0]?.destination, "vercel:production");
  assert.strictEqual(finalDests?.[0]?.ok, true);
  assert.strictEqual(finalDests?.[1]?.destination, "github-actions:acme/widgets");
  assert.strictEqual(finalDests?.[1]?.ok, true);
});

test("executeBatch: retry that fails again preserves prior ref + destinations_pushed", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "retry-again",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [
        { kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" },
      ],
    }],
    step_results: {
      API_KEY: {
        ok: false,
        ref: "ss://local/prod/API_KEY",
        destinations_pushed: [{ destination: "vercel:production", ok: false, error_code: "template_exec_failed", message: "exit 1" }],
        error_code: "destination_partial_failure",
      },
    },
    created_at: Date.now(),
    status: "failed_partial",
    owner_agent_id: "daemon",
  });

  // Destination fails again on retry.
  await executeBatch(store, "retry-again", makeDeps({
    runTemplate: async () => ({ executed: false, template_id: "vercel-env-add", secret_ref: "ss://local/prod/API_KEY", binary_path: null, binary_sha256: null, exit_code: 1, value_visible_to_agent: false as const }),
  }));

  const final = await store.get("retry-again");
  // Ref must still be preserved across the failed retry.
  assert.strictEqual(final?.step_results["API_KEY"]?.ref, "ss://local/prod/API_KEY", "prior ref must survive a second failed run");
  // destinations_pushed must reflect the latest attempt.
  assert.strictEqual(final?.step_results["API_KEY"]?.destinations_pushed?.[0]?.ok, false);
});

test("executeBatch: no prior ref → source step still runs as before", async () => {
  // Regression guard: existing single-run path must still work.
  const store = await setupStore();
  await store.save({
    batch_id: "fresh",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  let generateCalled = 0;
  await executeBatch(store, "fresh", makeDeps({
    generateSecret: async () => {
      generateCalled += 1;
      return { generated: true, secret_ref: "ss://local/prod/API_KEY", name: "API_KEY", environment: "production", fingerprint: "fp", value_visible_to_agent: false as const };
    },
  }));
  assert.strictEqual(generateCalled, 1, "source step must run on first attempt");
});

// ── R9: summarize() must surface per-destination failure detail (TDD) ────────

test("executeBatch: destination failure surfaces per-dest error_code + message + destination", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "destdetail",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [
        { kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" },
        { kind: "template", shorthand: "github-actions:acme/widgets", template_id: "github-actions-secret-set", template_params: {}, domain: "github.com" },
      ],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  // First destination succeeds (exit 0); second fails (exit 1).
  let callIdx = 0;
  const result = await executeBatch(store, "destdetail", makeDeps({
    runTemplate: async (_s, _p, input) => {
      callIdx += 1;
      const exit = callIdx === 1 ? 0 : 1;
      return {
        executed: exit === 0,
        template_id: (input as { templateId: string }).templateId,
        secret_ref: (input as { ref: string }).ref,
        binary_path: null,
        binary_sha256: null,
        exit_code: exit,
        value_visible_to_agent: false as const,
      };
    },
  }));

  assert.strictEqual(result.completed, 0, "one secret with any failed destination counts as failed");
  assert.strictEqual(result.failed, 1);
  // errors[] now carries one entry per failed destination.
  assert.strictEqual(result.errors.length, 1, "exactly one failed destination → one error entry");
  const err = result.errors[0]!;
  assert.strictEqual(err.secret, "API_KEY");
  assert.strictEqual(err.step, "destination");
  assert.strictEqual(err.code, "template_exec_failed");
  assert.strictEqual(err.destination, "github-actions:acme/widgets");
  assert.match(err.message, /exit.*1/i);
});

test("executeBatch: source-step failure still emits step: 'execute' error (no destination field)", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "srcfail",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [{ kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" }],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  const result = await executeBatch(store, "srcfail", makeDeps({
    generateSecret: async () => { throw new (await import("../../shared/errors.js")).ShuttleError("secret_exists", "already there"); },
  }));

  assert.strictEqual(result.completed, 0);
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.errors.length, 1);
  const err = result.errors[0]!;
  assert.strictEqual(err.step, "execute");
  assert.strictEqual(err.code, "secret_exists");
  assert.strictEqual(err.destination, undefined, "source-step errors must not carry a destination field");
});

test("executeBatch: multiple failed destinations for one secret → one error each", async () => {
  const store = await setupStore();
  await store.save({
    batch_id: "multidest",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [{
      secret: "API_KEY",
      ref: "ss://local/prod/API_KEY",
      source: { kind: "random_32_bytes" },
      destinations: [
        { kind: "template", shorthand: "vercel:production", template_id: "vercel-env-add", template_params: {}, domain: "vercel.com" },
        { kind: "template", shorthand: "github-actions:acme/widgets", template_id: "github-actions-secret-set", template_params: {}, domain: "github.com" },
        { kind: "template", shorthand: "cloudflare:production", template_id: "cloudflare-secret-put", template_params: {}, domain: "cloudflare.com" },
      ],
    }],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "daemon",
  });

  // All three fail.
  const result = await executeBatch(store, "multidest", makeDeps({
    runTemplate: async (_s, _p, input) => ({
      executed: false,
      template_id: (input as { templateId: string }).templateId,
      secret_ref: (input as { ref: string }).ref,
      binary_path: null,
      binary_sha256: null,
      exit_code: 1,
      value_visible_to_agent: false as const,
    }),
  }));

  assert.strictEqual(result.failed, 1, "one secret with any failed destinations still counts as 1 secret failure");
  assert.strictEqual(result.errors.length, 3, "three failed destinations → three error entries");
  assert.deepStrictEqual(
    result.errors.map(e => e.destination).sort(),
    ["cloudflare:production", "github-actions:acme/widgets", "vercel:production"],
  );
  for (const e of result.errors) {
    assert.strictEqual(e.step, "destination");
    assert.strictEqual(e.code, "template_exec_failed");
  }
});
