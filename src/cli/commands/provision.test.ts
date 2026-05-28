import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ShuttleError } from "../../shared/errors.js";
import { provisionCommand } from "./provision.js";

const execp = promisify(execFile);
const CLI = join(process.cwd(), "dist/cli/index.js");

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

test("provision --secret --from existing --ref accepts dotted source/env per canonical parseSecretRef", async () => {
  // §1 CTO-review P2a: validateSecretScalars used to enforce a parallel
  // regex /^ss:\/\/[a-z0-9_-]+\/[a-z0-9_-]+\/[A-Za-z_][A-Za-z0-9_]*$/ that
  // rejected dotted source/env/name components which the canonical
  // parseSecretRef (src/shared/refs.ts:65, SOURCE_RE/ENV_RE/NAME_RE) accepts.
  // After the fix, the CLI calls parseSecretRef directly — so a ref like
  // ss://my.source/prod/UPSTREAM_SECRET must no longer throw bad_request at
  // the CLI gate. The call still continues into the daemon request and will
  // fail with daemon_not_running in tests; the only assertion is that we do
  // NOT see bad_request from the now-replaced regex.
  const cmd = provisionCommand();
  let caught: { code: string | null; message: string | null } = { code: null, message: null };
  try {
    await cmd.parseAsync([
      "node",
      "provision",
      "--secret",
      "API_KEY",
      "--from",
      "existing",
      "--ref",
      "ss://my.source/prod/UPSTREAM_SECRET",
      "--to",
      "vercel:production",
    ]);
  } catch (err: any) {
    caught = { code: err?.code ?? null, message: err?.message ?? null };
  }
  // The dotted ref must not be rejected with bad_request from the CLI-side
  // regex. We allow any other error code (typically daemon_not_running in
  // test environments) to bubble through.
  if (caught.code === "bad_request") {
    assert.fail(
      `expected dotted ref to pass parseSecretRef; got bad_request with message: ${caught.message}`,
    );
  }
});

test("provision --secret with lowercase NAME is rejected at the CLI (matches yml parser strictness)", async () => {
  // §1 CTO-review P2a (part 2): the previous regex /^[A-Za-z_][A-Za-z0-9_]*$/
  // allowed lowercase / mixed-case names like `myKey`, but the yml parser
  // (src/cli/bootstrap/yml.ts:23) requires /^[A-Z][A-Z0-9_]*$/. The CLI now
  // enforces the stricter form, surfacing the failure at the CLI surface
  // with a focused message instead of letting `bootstrap_plan_invalid` come
  // back from the daemon at yml parse time.
  const cmd = provisionCommand();
  let caught: { code: string | null; message: string | null } = { code: null, message: null };
  try {
    await cmd.parseAsync([
      "node",
      "provision",
      "--secret",
      "myKey",
      "--from",
      "random_32_bytes",
      "--to",
      "vercel:production",
    ]);
  } catch (err: any) {
    caught = { code: err?.code ?? null, message: err?.message ?? null };
  }
  assert.equal(caught.code, "bad_request", `expected bad_request for lowercase name; got code=${caught.code} message=${caught.message}`);
  assert.ok(
    caught.message !== null && /[A-Z]/.test(caught.message) && caught.message.includes("myKey"),
    `expected message to name the invalid input and the UPPERCASE constraint; got: ${caught.message}`,
  );
  assert.ok(caught instanceof Object);
});

// Type-system check: ShuttleError import is exercised by the test above when
// the CLI throws — this guarantees the import survives tree-shaking review.
void ShuttleError;

test("provision --infer --environment <env> with non-executable plan: next_action includes --environment", async () => {
  // §1 CTO-review P2b: runInferMode used to emit
  //   next_action: "edit ./secret-shuttle.yml then run: secret-shuttle provision --yml ./secret-shuttle.yml"
  // dropping --environment from the recovery. After the fix, when the
  // original invocation included --environment <env>, the recovery string
  // preserves it so the subsequent `provision --yml` runs against the same
  // environment. Without this, --environment silently resets to production
  // at the daemon.
  const dir = await mkdtemp(join(tmpdir(), "ss-provision-infer-env-"));
  try {
    // MY_CUSTOM_FLAG is an unknown name (no inference rule) and there are
    // no framework files — runInfer returns executable: false with TODO
    // destinations, which takes the `needs_edit` branch in runInferMode.
    await writeFile(join(dir, ".env.example"), "MY_CUSTOM_FLAG=\n");

    // Run the CLI: provision --infer --environment staging
    let stdout = "";
    let exitCode = 0;
    try {
      const r = await execp("node", [CLI, "provision", "--infer", "--environment", "staging"], { cwd: dir });
      stdout = r.stdout;
    } catch (e: any) {
      stdout = e.stdout ?? "";
      exitCode = e.code ?? 1;
    }
    assert.equal(exitCode, 0, `expected exit 0 for needs_edit path; got ${exitCode} stdout=${stdout}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.needs_edit, true);
    assert.equal(
      parsed.next_action,
      "edit ./secret-shuttle.yml then run: secret-shuttle provision --yml ./secret-shuttle.yml --environment staging",
      `next_action must preserve --environment staging; got: ${parsed.next_action}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provision --infer (no --environment) with non-executable plan: next_action omits --environment", async () => {
  // Regression guard for the P2b fix: when --environment is NOT passed,
  // the next_action must remain the original literal string (no spurious
  // " --environment undefined").
  const dir = await mkdtemp(join(tmpdir(), "ss-provision-infer-noenv-"));
  try {
    await writeFile(join(dir, ".env.example"), "MY_CUSTOM_FLAG=\n");

    let stdout = "";
    let exitCode = 0;
    try {
      const r = await execp("node", [CLI, "provision", "--infer"], { cwd: dir });
      stdout = r.stdout;
    } catch (e: any) {
      stdout = e.stdout ?? "";
      exitCode = e.code ?? 1;
    }
    assert.equal(exitCode, 0, `expected exit 0; got ${exitCode}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.needs_edit, true);
    assert.equal(
      parsed.next_action,
      "edit ./secret-shuttle.yml then run: secret-shuttle provision --yml ./secret-shuttle.yml",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provision --infer --environment <env> with pre-existing yml: infer_yml_exists next_action includes --environment", async () => {
  // §1 CTO-review P2b (registry side): infer_yml_exists.nextAction is now
  // null in the registry. runInferMode constructs the recovery string
  // per-instance with the runtime opts.environment in scope, so the wire
  // next_action carries `--environment <env>` when the user passed it.
  const dir = await mkdtemp(join(tmpdir(), "ss-provision-infer-exists-env-"));
  try {
    await writeFile(join(dir, ".env.example"), "MY_CUSTOM_FLAG=\n");
    // Pre-existing yml triggers infer_yml_exists.
    await writeFile(join(dir, "secret-shuttle.yml"), "version: 1\nsecrets: {}\n");

    let stderr = "";
    let exitCode = 0;
    try {
      await execp("node", [CLI, "provision", "--infer", "--environment", "staging"], { cwd: dir });
    } catch (e: any) {
      stderr = e.stderr ?? "";
      exitCode = e.code ?? 1;
    }
    assert.equal(exitCode, 5, `expected exit 5 (CONFLICT) for infer_yml_exists; got ${exitCode}`);
    const parsed = JSON.parse(stderr);
    assert.equal(parsed.error_code, "infer_yml_exists");
    assert.equal(
      parsed.next_action,
      "secret-shuttle provision --infer --force --environment staging",
      `infer_yml_exists next_action must preserve --environment staging; got: ${parsed.next_action}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provision --infer with pre-existing yml (no --environment): infer_yml_exists next_action is bare --force", async () => {
  // Regression guard: when --environment is not passed, the next_action
  // remains `secret-shuttle provision --infer --force` (no trailing env).
  const dir = await mkdtemp(join(tmpdir(), "ss-provision-infer-exists-noenv-"));
  try {
    await writeFile(join(dir, ".env.example"), "MY_CUSTOM_FLAG=\n");
    await writeFile(join(dir, "secret-shuttle.yml"), "version: 1\nsecrets: {}\n");

    let stderr = "";
    let exitCode = 0;
    try {
      await execp("node", [CLI, "provision", "--infer"], { cwd: dir });
    } catch (e: any) {
      stderr = e.stderr ?? "";
      exitCode = e.code ?? 1;
    }
    assert.equal(exitCode, 5, `expected exit 5; got ${exitCode}`);
    const parsed = JSON.parse(stderr);
    assert.equal(parsed.error_code, "infer_yml_exists");
    assert.equal(
      parsed.next_action,
      "secret-shuttle provision --infer --force",
      `expected bare nextAction without trailing env; got: ${parsed.next_action}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provision --infer --environment 'staging; ls' is rejected with bad_request (shell injection guard)", async () => {
  // §1 CTO-review round-2 P1.2: the previous code interpolated
  // opts.environment directly into next_action strings without
  // validation. `--environment 'staging; ls'` would survive into the
  // wire JSON, and an agent running next_action through a shell would
  // execute the injected command. The fix validates --environment
  // against /^[a-zA-Z0-9_-]+$/ in validateProvisionScalars, called
  // from every provision mode that forwards env.
  const cmd = provisionCommand();
  let caught: { code: string | null; message: string | null } = { code: null, message: null };
  try {
    await cmd.parseAsync([
      "node",
      "provision",
      "--infer",
      "--environment",
      "staging; ls",
    ]);
  } catch (err: any) {
    caught = { code: err?.code ?? null, message: err?.message ?? null };
  }
  assert.equal(
    caught.code,
    "bad_request",
    `expected bad_request for env with shell metacharacters; got code=${caught.code} message=${caught.message}`,
  );
  assert.ok(
    caught.message !== null && caught.message.includes("--environment"),
    `expected message to name the --environment flag; got: ${caught.message}`,
  );
  assert.ok(
    caught.message !== null && caught.message.includes("staging; ls"),
    `expected message to include the rejected value; got: ${caught.message}`,
  );
});

test("provision --secret --environment '$(rm -rf)' is rejected with bad_request (shell injection guard)", async () => {
  // Same P1.2 fix as the --infer test above, but exercised through the
  // --secret mode codepath. The validator runs in every provision mode
  // that accepts --environment.
  const cmd = provisionCommand();
  let caught: { code: string | null; message: string | null } = { code: null, message: null };
  try {
    await cmd.parseAsync([
      "node",
      "provision",
      "--secret",
      "API_KEY",
      "--from",
      "random_32_bytes",
      "--to",
      "vercel:production",
      "--environment",
      "$(rm -rf /)",
    ]);
  } catch (err: any) {
    caught = { code: err?.code ?? null, message: err?.message ?? null };
  }
  assert.equal(
    caught.code,
    "bad_request",
    `expected bad_request for env with command substitution; got code=${caught.code} message=${caught.message}`,
  );
});

test("provision --infer --environment 'staging-eu_1' (valid token) does not reject at the validator", async () => {
  // Positive case for the P1.2 validator: alphanumeric + underscore +
  // hyphen are allowed. We expect the CLI to pass argv through to the
  // infer pipeline (which typically writes a yml and exits 0 in this
  // directory shape). The only assertion is that bad_request is NOT
  // thrown by the validator.
  const dir = await mkdtemp(join(tmpdir(), "ss-provision-env-valid-"));
  try {
    await writeFile(join(dir, ".env.example"), "MY_CUSTOM_FLAG=\n");

    let exitCode = 0;
    let stderr = "";
    try {
      await execp("node", [CLI, "provision", "--infer", "--environment", "staging-eu_1"], { cwd: dir });
    } catch (e: any) {
      exitCode = e.code ?? 1;
      stderr = e.stderr ?? "";
    }
    // The CLI may exit 0 (needs_edit path) or non-zero for downstream
    // reasons (e.g., daemon unreachable in CI). What MUST NOT happen
    // is a CLI-side bad_request rejection for the env value itself.
    if (exitCode !== 0) {
      // Confirm no validator-side bad_request fired for the env.
      assert.ok(
        !stderr.includes("--environment must match"),
        `valid token 'staging-eu_1' was rejected by validator; stderr: ${stderr}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
