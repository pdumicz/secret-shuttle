import { test } from "node:test";
import assert from "node:assert/strict";
import { provisionCommand } from "./provision.js";

test("provisionCommand returns a Command named 'provision'", () => {
  const cmd = provisionCommand();
  assert.equal(cmd.name(), "provision");
});

test("provisionCommand has the expected mode flags", () => {
  const cmd = provisionCommand();
  const opts = cmd.options.map((o) => o.long);
  for (const flag of ["--infer", "--yml", "--secret", "--continue", "--list", "--abandon", "--dry-run", "--force"]) {
    assert.ok(opts.includes(flag), `expected flag ${flag} in provision options, got: ${opts.join(", ")}`);
  }
});

test("provisionCommand has --from, --url, --ref, --to, --approval-id, --batch, --environment", () => {
  const cmd = provisionCommand();
  const opts = cmd.options.map((o) => o.long);
  for (const flag of ["--from", "--url", "--ref", "--to", "--approval-id", "--batch", "--environment"]) {
    assert.ok(opts.includes(flag), `expected ${flag}, got: ${opts.join(", ")}`);
  }
});

test("provision --continue with --batch but no --approval-id does not throw missing_param at the CLI layer", async () => {
  // P1.1 regression: the daemon /continue route only consumes the bootstrap
  // approval on the FIRST call (state.status === "pending"). For retries on
  // in_progress / failed_partial the batch_id + locked-daemon precondition are
  // the authorization, so the CLI must let approval-id-less calls through.
  // We verify that the CLI surface no longer rejects argv before it reaches
  // the daemon; we expect a downstream daemon-side error (typically
  // daemon_not_running in CI) instead of the old CLI-layer missing_param.
  //
  // NB: do NOT stub process.stdout.write here — the node:test reporter writes
  // tests-passed lines to stdout and stubbing it swallows ALL prior tests'
  // reporter output, which manifests as "tests 1" instead of "tests 4".
  const cmd = provisionCommand();
  let caughtCode: string | null = null;
  try {
    await cmd.parseAsync(["node", "provision", "--continue", "--batch", "test-batch-id"]);
  } catch (err: any) {
    caughtCode = err?.code ?? null;
  }
  // Whatever bubbles up, it must NOT be missing_param (the old CLI-layer
  // rejection). It is typically daemon_not_running in test environments.
  assert.notEqual(caughtCode, "missing_param", `expected the CLI to pass argv through; got missing_param`);
});
