import test from "node:test";
import assert from "node:assert/strict";
import { buildProgram } from "../cli/build-program.js";
import { extractShuttleInvocations, resolveCommandPath } from "./demo-command-scan.js";

const program = buildProgram();
const ok = (tokens: string[]) => resolveCommandPath(program, tokens).ok;

test("resolveCommandPath accepts real command paths (incl. positionals & options)", () => {
  assert.ok(ok(["status"]));
  assert.ok(ok(["status", "--json"]));
  assert.ok(ok(["secrets", "set"]));
  assert.ok(ok(["secrets", "list", "--env", "production"]));
  assert.ok(ok(["agent", "install", "claude"]));        // <target> positional
  assert.ok(ok(["template", "run", "vercel-env-add"]));  // <template-id> positional
  assert.ok(ok(["secrets", "delete", "ss://stripe/prod/X"])); // <ref> positional
  assert.ok(ok(["browser", "mark", "pick", "--as", "reveal-btn"]));
  assert.ok(ok(["reveal-capture"]));
  assert.ok(ok(["inject-submit"]));
  assert.ok(ok(["internal", "blind", "end"]));
  assert.ok(ok(["init"]));
  assert.ok(ok(["provision", "--infer"]));
});

test("resolveCommandPath rejects removed verbs and invalid leaf pairings", () => {
  assert.ok(!ok(["doctor"]));                    // removed in v0.3.0 → status
  assert.ok(!ok(["doctor", "--json"]));
  assert.ok(!ok(["generate"]));                  // removed → secrets set / provision --secret
  assert.ok(!ok(["secrets", "generate"]));       // valid parent, invalid leaf
  assert.ok(!ok(["agent", "setup", "claude"]));  // valid parent, invalid leaf
});

test("resolveCommandPath enforces metadata: option names, positional arity, help passthrough", () => {
  // `help <command>` re-resolves its variadic positional as a real command path —
  // a removed verb laundered through `help` must NOT pass the guard.
  assert.ok(ok(["help"]));                        // bare help → top-level help
  assert.ok(ok(["help", "secrets", "set"]));      // help for a real command path
  assert.ok(!ok(["help", "doctor"]));             // removed verb via help → invalid
  assert.ok(!ok(["help", "secrets", "generate"]));// invalid leaf via help → invalid

  // Unknown option names are rejected (Commander metadata, not a guess).
  assert.ok(!ok(["status", "--frobnicate"]));     // no such option on status
  assert.ok(ok(["status", "--json"]));            // registered boolean option

  // Value-bearing options consume their value, which is NOT a positional.
  assert.ok(ok(["secrets", "list", "--env", "production"]));   // --env <value>; `production` not a positional
  assert.ok(ok(["secrets", "list", "--env=production"]));      // inline value form

  // Positional arity: `status` declares zero positionals → an extra token fails;
  // `secrets delete <ref>` declares one → a second positional fails.
  assert.ok(!ok(["status", "extra-arg"]));        // status takes no positional
  assert.ok(!ok(["secrets", "delete", "ss://a/b/C", "ss://x/y/Z"])); // one too many positionals

  // Positional MINIMUM: a required `<positional>` that is omitted must fail,
  // not just an extra one. These leaf commands each declare one required arg.
  assert.ok(!ok(["agent", "install"]));           // missing required <target>
  assert.ok(!ok(["template", "run"]));            // missing required <template-id>
  assert.ok(!ok(["secrets", "delete"]));          // missing required <ref>
});

test("extractShuttleInvocations pulls command tokens and tolerates prose", () => {
  assert.deepEqual(
    extractShuttleInvocations('<span class="args">(secret-shuttle status --json)</span>'),
    [["status", "--json"]],
  );
  assert.deepEqual(
    extractShuttleInvocations("(secret-shuttle secrets set \\"),
    [["secrets", "set"]],
  );
  // Backslash line-continuations are folded so continuation-line options are part
  // of the SAME invocation (Scene 5's multi-flag `secrets set` form). Without the
  // fold, `--name`/`--kind`/… would be invisible to the option-name check.
  assert.deepEqual(
    extractShuttleInvocations(
      "(secret-shuttle secrets set \\\n--name INTERNAL_CRON_SECRET --env production \\\n--kind random_32_bytes)",
    ),
    [["secrets", "set", "--name", "INTERNAL_CRON_SECRET", "--env", "production", "--kind", "random_32_bytes"]],
  );
  assert.deepEqual(
    extractShuttleInvocations("  secret-shuttle agent install codex     # AGENTS.md"),
    [["agent", "install", "codex"]],
  );
  // Prose / filenames / npm output do NOT trigger (no whitespace after the name).
  assert.deepEqual(extractShuttleInvocations("Wrote secret-shuttle.yml — 3 secrets"), []);
  assert.deepEqual(extractShuttleInvocations("+ secret-shuttle@0.1.1"), []);
  assert.deepEqual(extractShuttleInvocations("I heard about secret-shuttle. set it up"), []);
  assert.deepEqual(extractShuttleInvocations("(npm install -g secret-shuttle)"), []);

  // A shell-quoted multi-word option value is ONE token, not three. Without quote
  // grouping, `Environment Variable Added` would split into spurious positionals.
  assert.deepEqual(
    extractShuttleInvocations(
      'secret-shuttle inject-submit --success-text "Environment Variable Added" --domain vercel.com',
    ),
    [["inject-submit", "--success-text", "Environment Variable Added", "--domain", "vercel.com"]],
  );
});

test("end-to-end: a `doctor` form fails, `npx … init` passes", () => {
  for (const inv of extractShuttleInvocations("(secret-shuttle doctor)")) {
    assert.ok(!resolveCommandPath(program, inv).ok, "doctor must fail");
  }
  for (const inv of extractShuttleInvocations("(npx secret-shuttle init)")) {
    assert.ok(resolveCommandPath(program, inv).ok, "init must pass");
  }
});

test("end-to-end: inject-submit with quoted multi-word --success-text resolves", () => {
  // End-to-end: the realistic Scene-8 invocation (quoted success marker) must resolve.
  assert.ok(
    resolveCommandPath(program, [
      "inject-submit",
      "--success-text",
      "Environment Variable Added",
      "--domain",
      "vercel.com",
    ]).ok,
    "inject-submit with a quoted multi-word --success-text value must resolve to a registered path",
  );
});
