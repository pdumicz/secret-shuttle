# Secret Shuttle — Honesty Pass (demo + README + demo drift-guard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `demo/index.html` and `README.md` tell the truth about the shipped v0.4.0 CLI (no removed commands, the real 2-step magic path, an `init` install line, a DOM-scoped absence-proof claim), and extend the drift-guard so the demo cannot silently regress again.

**Architecture:** Three source-touching pieces support an otherwise docs-only change. (1) Extract the Commander command tree into a side-effect-free `buildProgram()` so tests can read the registered command set without parsing argv. (2) A small, unit-tested scanner (`extractShuttleInvocations` + `resolveCommandPath`) resolves each demo command string to a registered command *path* and then validates the trailing tokens against that command's Commander metadata (option names, positional arity, and a `help <command>` passthrough) so the guard rejects drift instead of rubber-stamping any option-or-trailing-token shape. (3) The existing line-by-line token drift-guard gains `demo/index.html` plus two new checks (registry-backed path resolution; a Scene-3 install-shape assertion). With the guard wired first (red), the demo and README edits turn it green.

**Tech Stack:** TypeScript (ESM, `"module": "nodenext"`), Commander.js v12, `node:test` + `node:assert/strict`. Tests run from compiled output: `npm test` = `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/**/*.test.js"`. Node ≥ 20.

**Spec:** `docs/superpowers/specs/2026-05-30-secret-shuttle-honesty-pass-design.md`

---

## File Structure

**Created:**
- `src/cli/build-program.ts` — exports `buildProgram(): Command`. Single source of truth for the registered command tree; builds and returns the configured `Command` **without** `parse`/`parseAsync`/`help`/exit. Consumed by the CLI entrypoint and the drift-guard.
- `src/cli/build-program.test.ts` — unit test: the factory returns a `secret-shuttle` tree with the expected top-level commands, a fresh instance per call, and no argv parse.
- `src/e2e/demo-command-scan.ts` — pure helpers `extractShuttleInvocations(rawText)` and `resolveCommandPath(program, tokens)`. The resolver walks the registered command tree, then validates remaining tokens against the leaf command's Commander metadata (option names, positional arity, `help <command>` passthrough) so the guard catches drift rather than rubber-stamping it. No top-level side effects; safe to import from tests.
- `src/e2e/demo-command-scan.test.ts` — unit test for the two helpers, validated against the **real** `buildProgram()` registry.

**Modified:**
- `src/cli/index.ts` — stops building the tree inline; imports and calls `buildProgram()`, keeps the argv-parse + error-rendering shell. Runtime behavior of the entrypoint is unchanged.
- `src/e2e/docs-no-removed-verbs.test.ts` — add `demo/index.html` to `DOCS` (reuses the token scan); add the registry-backed command-path test; add the Scene-3 install-shape test.
- `demo/index.html` — Scenes 0, 3, 4, 5, 7, 8, 9 copy/stage edits + the `NAMES` array + one HTML comment.
- `README.md` — install line (Touch ID), "What Works Today" (add keychain / rotate / import / delete), "What Does Not Work Yet" (narrow keychain → hardware-backed; rotation/import/export → export).

**Why `buildProgram()` is safe to extract (verified):** no module imports the `program` object from `src/cli/index.ts`. The only references to `dist/cli/index.js` are subprocess spawns in tests (`migrate.test.ts`, `cli-help-discoverability.test.ts`, `bootstrap-removed.test.ts`, `provision.test.ts`). The entrypoint still parses argv exactly as before, so those subprocess tests are unaffected.

---

### Task 1: Extract a side-effect-free `buildProgram()`

**Files:**
- Create: `src/cli/build-program.ts`
- Test: `src/cli/build-program.test.ts`
- Modify: `src/cli/index.ts` (currently builds `program` at module top-level on lines 25–66, then parses on 68–82)

- [ ] **Step 1: Write the failing test**

Create `src/cli/build-program.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { buildProgram } from "./build-program.js";

test("buildProgram returns the configured secret-shuttle command tree", () => {
  const program = buildProgram();
  assert.ok(program instanceof Command);
  assert.equal(program.name(), "secret-shuttle");

  const top = program.commands.map((c) => c.name()).sort();
  for (const expected of [
    "agent", "audit", "bootstrap", "browser", "daemon", "help", "import",
    "init", "inject", "inject-submit", "internal", "keychain", "migrate",
    "provision", "reveal-capture", "run", "secrets", "status", "template",
    "unlock",
  ]) {
    assert.ok(top.includes(expected), `expected top-level command \`${expected}\``);
  }
});

test("buildProgram is side-effect-free: fresh instance per call, no argv parse", () => {
  const a = buildProgram();
  const b = buildProgram();
  assert.notEqual(a, b, "each call must return an independent Command instance");
  // Commander populates `.args` only during parse(); a freshly built program has none.
  assert.deepEqual(a.args, [], "buildProgram must not parse argv");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL — TypeScript cannot resolve `./build-program.js` (module does not exist yet).

- [ ] **Step 3: Create `src/cli/build-program.ts`**

Move the command-tree construction (current `index.ts:1`–`66`, minus the shebang and the parse block) into an exported factory. `ShuttleError` is needed here for the `bootstrap` stub; `errorToJson` and `consumePendingDeprecationWarning` stay in the entrypoint (parse-only).

```ts
import { Command } from "commander";
import { browserCommand } from "./commands/browser.js";
import { daemonCommand } from "./commands/daemon.js";
import { initCommand } from "./commands/init.js";
import { injectSubmitCommand } from "./commands/inject-submit.js";
import { revealCaptureCommand } from "./commands/reveal-capture.js";
import { unlockCommand } from "./commands/unlock.js";
import { templateCommand } from "./commands/template.js";
import { migrateCommand } from "./commands/migrate.js";
import { statusCommand } from "./commands/status.js";
import { agentCommand } from "./commands/agent.js";
import { secretsCommand } from "./commands/secrets/index.js";
import { keychainCommand } from "./commands/keychain/index.js";
import { runCommand } from "./commands/run.js";
import { injectCommand } from "./commands/inject.js";
import { importCommand } from "./commands/import.js";
import { provisionCommand } from "./commands/provision.js";
import { internalCommand } from "./commands/internal.js";
import { helpCommand } from "./commands/help.js";
import { auditCommand } from "./commands/audit.js";
import { ShuttleError } from "../shared/errors.js";

/**
 * Build the fully-configured `secret-shuttle` Commander tree WITHOUT parsing
 * argv, printing help, or exiting. Single source of truth for the registered
 * command set: consumed by the CLI entrypoint (src/cli/index.ts) and by the
 * docs/demo drift-guard (src/e2e/docs-no-removed-verbs.test.ts). Calling it has
 * no side effects beyond allocating Command objects, so it is safe to import
 * from tests.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("secret-shuttle")
    .description(
      "Local-daemon CLI for AI coding agents.\nAGENT QUICKSTART: read skills/secret-shuttle/SKILL.md or run `secret-shuttle help`.",
    )
    .version("0.1.1");

  program.addCommand(initCommand());
  program.addCommand(browserCommand());
  program.addCommand(injectSubmitCommand());
  program.addCommand(revealCaptureCommand());
  program.addCommand(unlockCommand());
  program.addCommand(templateCommand());
  program.addCommand(daemonCommand());
  program.addCommand(migrateCommand());
  program.addCommand(statusCommand());
  program.addCommand(agentCommand());
  program.addCommand(secretsCommand());
  program.addCommand(keychainCommand());
  program.addCommand(importCommand());
  program.addCommand(provisionCommand());

  // Stub `bootstrap` so running it surfaces command_renamed via the top-level
  // catch in src/cli/index.ts (writes JSON to stderr, sets exitCode).
  // DO NOT outputJson + process.exit here — that bypasses the top-level
  // deprecation-warning handling and writes to stdout instead of stderr.
  const bootstrapStub = new Command("bootstrap")
    .description("Renamed to `provision` in v0.3.0.")
    .allowUnknownOption()
    .action(() => {
      throw new ShuttleError(
        "command_renamed",
        "The `bootstrap` verb was renamed to `provision` in v0.3.0. Re-run with `secret-shuttle provision <same flags>`.",
      );
    });
  program.addCommand(bootstrapStub);

  program.addCommand(runCommand());
  program.addCommand(injectCommand());
  program.addCommand(auditCommand());
  program.addCommand(internalCommand(), { hidden: true });
  program.addCommand(helpCommand());

  return program;
}
```

- [ ] **Step 4: Rewrite `src/cli/index.ts` to consume `buildProgram()`**

Replace the entire current contents of `src/cli/index.ts` with:

```ts
#!/usr/bin/env node
import { buildProgram } from "./build-program.js";
import { ShuttleError, errorToJson } from "../shared/errors.js";
import { consumePendingDeprecationWarning } from "../shared/deprecation.js";

const program = buildProgram();

if (process.argv.length <= 2) {
  program.help();
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const errJson = errorToJson(error) as Record<string, unknown>;
  const warning = consumePendingDeprecationWarning();
  if (warning !== null) {
    errJson.warning = warning;
  }
  process.stderr.write(`${JSON.stringify(errJson, null, 2)}\n`);
  process.exitCode = error instanceof ShuttleError ? error.exitCode : 1;
}
```

- [ ] **Step 5: Build and run the new unit test**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/build-program.test.js"`
Expected: PASS (both tests).

- [ ] **Step 6: Confirm the entrypoint still behaves identically (subprocess tests)**

Run: `SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/commands/cli-help-discoverability.test.js" "dist/cli/commands/bootstrap-removed.test.js" "dist/cli/commands/migrate.test.js" "dist/cli/commands/provision.test.js"`
Expected: PASS. These spawn `node dist/cli/index.js …`; the extraction must not change argv parsing, help output, or the `bootstrap` → `command_renamed` behavior.

- [ ] **Step 7: Commit**

```bash
git add src/cli/build-program.ts src/cli/build-program.test.ts src/cli/index.ts
git commit -m "refactor(cli): extract side-effect-free buildProgram() as the registered-command source of truth"
```

---

### Task 2: Tested command-path scanner (`demo-command-scan`)

**Files:**
- Create: `src/e2e/demo-command-scan.ts`
- Test: `src/e2e/demo-command-scan.test.ts`

This is the registry-backed validator the demo guard will use. It is a standalone, unit-tested module (not buried in the test file) so its behavior is independently verifiable.

- [ ] **Step 1: Write the failing test**

Create `src/e2e/demo-command-scan.test.ts`:

```ts
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
});

test("end-to-end: a `doctor` form fails, `npx … init` passes", () => {
  for (const inv of extractShuttleInvocations("(secret-shuttle doctor)")) {
    assert.ok(!resolveCommandPath(program, inv).ok, "doctor must fail");
  }
  for (const inv of extractShuttleInvocations("(npx secret-shuttle init)")) {
    assert.ok(resolveCommandPath(program, inv).ok, "init must pass");
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL — TypeScript cannot resolve `./demo-command-scan.js`.

- [ ] **Step 3: Implement `src/e2e/demo-command-scan.ts`**

```ts
import type { Command } from "commander";

/**
 * Extract every `secret-shuttle …` invocation from raw HTML/text, returning one
 * token array per invocation (the command path plus ALL its arg/option tokens —
 * including those on backslash-continuation lines, which the demo uses for
 * multi-flag commands like Scene 5's `secrets set`). HTML tags are stripped and a
 * few entities decoded first; then trailing-`\` line continuations are folded
 * into a single logical line BEFORE matching, so continuation-line options
 * (`--name`, `--kind`, …) are part of the invocation and get validated against
 * the resolved command's option metadata rather than being silently invisible.
 *
 * Conservative by design — the demo also embeds `secret-shuttle` in prose,
 * filenames, and npm output:
 *  - Triggers only on `secret-shuttle` followed by whitespace, so `secret-shuttle.yml`,
 *    `secret-shuttle@0.1.1`, `secret-shuttle.` (prose) and `… secret-shuttle)` never match.
 *  - Token collection stops at the first non-argument-shaped token (e.g. a `#`
 *    comment or a prose word with punctuation); lone punctuation such as a trailing
 *    `\` is dropped. The command PATH always leads, so it survives intact.
 */
export function extractShuttleInvocations(rawText: string): string[][] {
  const text = rawText
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    // Fold shell line-continuations: a `\` at end-of-line (optionally followed by
    // trailing whitespace) joins the next line into the same logical invocation.
    // The demo renders each continuation as its own DOM node, so after tag
    // stripping the `\` is followed by whitespace/newline — this stitches the
    // `secrets set \  --name … \  --kind …` form back into one line.
    .replace(/\\[ \t]*\r?\n/g, " ");

  const invocations: string[][] = [];
  const re = /secret-shuttle[ \t]+([^\r\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tokens: string[] = [];
    for (const raw of (m[1] ?? "").split(/\s+/)) {
      const tok = cleanToken(raw);
      if (tok === null) break; // non-argument boundary (prose / comment) → stop
      if (tok === "") continue; // dropped punctuation (e.g. a lone `\`)
      tokens.push(tok);
    }
    if (tokens.length > 0) invocations.push(tokens);
  }
  return invocations;
}

// Returns the cleaned token, "" to skip it, or null to STOP collecting this invocation.
function cleanToken(raw: string): string | null {
  const t = raw.replace(/^[("'`]+/, "").replace(/[)"'`,;\\]+$/, "");
  if (t === "") return ""; // was pure punctuation (lone `\`, `(`, …)
  if (t.startsWith("#")) return null; // shell comment → stop
  if (t.startsWith("-")) return t; // option token → keep
  if (/^[A-Za-z0-9][A-Za-z0-9._:/@=-]*$/.test(t)) return t; // command / positional / value
  return null; // prose word with punctuation, etc. → stop
}

export interface PathResult {
  ok: boolean;
  resolvedPath: string[];
  reason: string;
}

// Minimal structural views over Commander internals we read (no public getters).
// `required` is true for a `<name>` positional and false for a `[name]` one
// (Commander records it on the Argument). We read it to enforce the required
// MINIMUM, not just the arity maximum.
interface RegisteredArg { _name: string; variadic: boolean; required: boolean }
interface CmdOption { long?: string | null; short?: string | null; required?: boolean; optional?: boolean }
interface CmdInternals {
  registeredArguments: RegisteredArg[];
  options: CmdOption[];
  _allowUnknownOption?: boolean;
}
const internals = (c: Command): CmdInternals => c as unknown as CmdInternals;
// A `--flag <value>` / `--flag [value]` option consumes the following token as
// its value; a boolean `--flag` does not. Commander records this on the option.
const takesValue = (o: CmdOption): boolean => o.required === true || o.optional === true;

// Walk the registered subcommand tree as far as the leading non-option tokens go.
// Returns the resolved leaf and the index of the first token it did NOT consume.
function walkPath(start: Command, tokens: string[], from: number): { node: Command; next: number; path: string[] } {
  let node: Command = start;
  const path: string[] = [];
  let i = from;
  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("-")) break;
    const sub = node.commands.find((c) => c.name() === tok || c.aliases().includes(tok));
    if (!sub) break;
    node = sub;
    path.push(tok);
  }
  return { node, next: i, path };
}

/**
 * Resolve the LONGEST registered command path for a token sequence, then VALIDATE
 * the remaining tokens against the resolved command's Commander metadata so the
 * guard actually catches drift instead of waving everything through:
 *  - consumed nothing → leading token is not a top-level command (e.g. `doctor`) → invalid.
 *  - `help <args…>` is special: its variadic positional is itself a COMMAND PATH,
 *    so the trailing tokens are re-resolved as a path from the program root. This
 *    is what stops `secret-shuttle help doctor` (a removed verb laundered through
 *    `help`) from silently passing.
 *  - option tokens (`-…`) are validated by name against the command's registered
 *    options (long/short), with `--help`/`-h` always allowed and any option accepted
 *    when the command opts into `allowUnknownOption()` (e.g. the `bootstrap` stub).
 *  - trailing non-option tokens are checked against declared positional ARITY: a
 *    command with N non-variadic positionals accepts at most N of them; a variadic
 *    positional accepts the rest. A command with zero positionals accepts none.
 *  - declared positional MINIMUM: a command with N required `<positional>`s must
 *    receive at least N (so `agent install`, `template run`, `secrets delete` fail
 *    when their required positional is missing, not just when extras are supplied).
 */
export function resolveCommandPath(program: Command, tokens: string[]): PathResult {
  const { node, next, path: resolvedPath } = walkPath(program, tokens, 0);

  if (resolvedPath.length === 0) {
    return { ok: false, resolvedPath, reason: `\`${tokens[0] ?? ""}\` is not a registered command` };
  }

  // `help <command path>` — re-resolve the trailing tokens as a real command path.
  if (node.name() === "help") {
    const rest = tokens.slice(next).filter((t) => !t.startsWith("-"));
    if (rest.length === 0) return { ok: true, resolvedPath, reason: "" };
    const sub = walkPath(program, rest, 0);
    if (sub.path.length === rest.length) return { ok: true, resolvedPath: [...resolvedPath, ...rest], reason: "" };
    return {
      ok: false,
      resolvedPath,
      reason: `\`help ${rest.join(" ")}\` names \`${rest[sub.path.length] ?? rest[0]}\`, which is not a registered command`,
    };
  }

  const meta = internals(node);
  const positionalSlots = meta.registeredArguments.length;
  const hasVariadic = meta.registeredArguments.some((a) => a.variadic);
  const requiredPositionals = meta.registeredArguments.filter((a) => a.required).length;
  let positionalsSeen = 0;

  for (let i = next; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("-")) {
      if (meta._allowUnknownOption) continue;
      // `--name=value` carries its own value; `--name value` consumes the next token.
      const inlineValue = tok.includes("=");
      const flag = inlineValue ? tok.slice(0, tok.indexOf("=")) : tok;
      if (flag === "--help" || flag === "-h") continue;
      const opt = meta.options.find((o) => o.long === flag || o.short === flag);
      if (!opt) {
        return { ok: false, resolvedPath, reason: `\`${resolvedPath.join(" ")}\` has no option \`${flag}\`` };
      }
      // Skip a value-bearing option's value token so it is not miscounted as a
      // positional (e.g. `secrets list --env production`: `production` is --env's value).
      if (!inlineValue && takesValue(opt) && i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-")) {
        i++;
      }
      continue;
    }
    // Non-option positional: must fit declared arity (variadic soaks up extras).
    positionalsSeen++;
    if (!hasVariadic && positionalsSeen > positionalSlots) {
      return {
        ok: false,
        resolvedPath,
        reason: `\`${resolvedPath.join(" ")}\` accepts ${positionalSlots} positional argument(s) but got an extra \`${tok}\``,
      };
    }
  }
  // Required MINIMUM: a command with N required `<positional>`s must receive at
  // least N. Without this, `secret-shuttle agent install`, `template run`, or
  // `secrets delete` (each missing its required positional) would pass the guard.
  if (positionalsSeen < requiredPositionals) {
    return {
      ok: false,
      resolvedPath,
      reason: `\`${resolvedPath.join(" ")}\` requires ${requiredPositionals} positional argument(s) but got ${positionalsSeen}`,
    };
  }
  return { ok: true, resolvedPath, reason: "" };
}
```

**Implementer notes on the Commander metadata reads (verified against v12):**
- `registeredArguments` is populated for **both** declaration forms — `.command("install <target>")` (the name string's `<…>`/`[…]` segments) and `.argument("<ref>")`. `command.name()` returns just the verb (`"install"`), with the positionals carried separately, so `walkPath` resolves the subcommand by name while arity is read from `registeredArguments`. This is why `agent install claude`, `template run <id>`, and `secrets delete <ref>` all pass (one declared positional, one supplied), while `status extra-arg` fails (zero declared positionals).
- An `Argument`'s `variadic` flag (true for `[command...]` / `<x...>`) is read to let variadic commands soak up extra positionals. The `help` command's variadic `[command...]` is handled by the dedicated `help` passthrough *before* the generic arity loop, so its tokens are validated as a command path rather than waved through as positional values.
- A value-bearing option is detected via Commander's `Option.required` / `Option.optional` (set for `--flag <value>` / `--flag [value]`); boolean flags have both false. If the v12 field names differ at implementation time, fall back to parsing the option's `flags` string for a `<…>`/`[…]` segment — the behavior (consume the value token) must hold so option values are not miscounted as positionals.
- If any of these private fields are renamed in the installed Commander version, the unit tests in Step 1 will fail loudly (e.g. `secrets list --env production` or `status extra-arg`), which is the intended tripwire — adjust the structural view, not the assertions.

- [ ] **Step 4: Build and run the unit test**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/e2e/demo-command-scan.test.js"`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add src/e2e/demo-command-scan.ts src/e2e/demo-command-scan.test.ts
git commit -m "test(e2e): add registry-backed command-path scanner for the demo drift-guard"
```

---

### Task 3: Extend the drift-guard to cover the demo, then correct the demo (TDD red → green)

**Files:**
- Modify: `src/e2e/docs-no-removed-verbs.test.ts`
- Modify: `demo/index.html`

The guard is wired first so it goes **red** against the still-broken demo (proving it detects the drift), then the demo edits turn it **green**. Both are committed together.

- [ ] **Step 1: Add the new imports to `src/e2e/docs-no-removed-verbs.test.ts`**

After the existing import block (currently ending at `import { join } from "node:path";`, line 39), add:

```ts
import { buildProgram } from "../cli/build-program.js";
import { extractShuttleInvocations, resolveCommandPath } from "./demo-command-scan.js";
```

- [ ] **Step 2: Add `demo/index.html` to the `DOCS` array (Check 1 — reuse the token scan)**

Replace the existing `DOCS` array (lines 53–58):

```ts
const DOCS: string[] = [
  "skills/secret-shuttle/SKILL.md",
  ...AGENT_DOCS,
  "README.md",
  "examples/stripe-to-vercel/walkthrough.md",
];
```

with:

```ts
const DOCS: string[] = [
  "skills/secret-shuttle/SKILL.md",
  ...AGENT_DOCS,
  "README.md",
  "examples/stripe-to-vercel/walkthrough.md",
  // Burst-7 honesty pass: the demo was the one agent-facing surface NOT scanned,
  // which is exactly why removed `doctor`/`generate` survived here. Now covered.
  "demo/index.html",
];
```

- [ ] **Step 3: Append Check 2 (registry-backed command-path) and Check 3 (Scene-3 install-shape)**

At the end of the file (after the existing `MOVED_TOKENS` adjacency test), append:

```ts
// Check 2 (Burst-7 honesty pass): every `secret-shuttle …` invocation rendered in
// the demo must resolve to a registered command PATH — not merely a registered
// top-level verb. `doctor` (removed in v0.3.0) is in neither token list above, so
// only a registry-backed path check catches it; the same check catches invalid
// leaf pairings like `secrets generate` or `agent setup claude`. The registry is
// the side-effect-free buildProgram() shared with the CLI entrypoint, so it stays
// self-maintaining as commands are added/removed.
test("demo: every `secret-shuttle …` invocation resolves to a registered command path", async () => {
  const program = buildProgram();
  const html = await readFile(join(process.cwd(), "demo/index.html"), "utf8");
  const invocations = extractShuttleInvocations(html);
  assert.ok(
    invocations.length > 0,
    "expected to extract at least one `secret-shuttle …` invocation from the demo",
  );
  for (const tokens of invocations) {
    const result = resolveCommandPath(program, tokens);
    assert.ok(
      result.ok,
      `demo/index.html renders \`secret-shuttle ${tokens.join(" ")}\` but ${result.reason}. ` +
        `Use a registered command (the registry is buildProgram()).`,
    );
  }
});

// Check 3 (Burst-7 honesty pass): keep the removed install ritual out of Scene 3.
// `secret-shuttle daemon start` and `secret-shuttle unlock` are still REGISTERED
// commands (so Check 2 passes them), and `npm install -g secret-shuttle` is not a
// `secret-shuttle <verb>` form at all (so Check 2 never sees it). Assert Scene 3's
// stage uses `npx secret-shuttle init` and contains none of the old ritual's CLI
// command strings. Scoped to the CLI strings, within Scene 3's stage only, so the
// retained passphrase-window button copy "Create & unlock" is unaffected.
test("demo: Scene 3 install uses `npx secret-shuttle init`, not the removed ritual", async () => {
  const html = await readFile(join(process.cwd(), "demo/index.html"), "utf8");
  const start = html.indexOf('class="scene-stage" data-scene="3"');
  assert.notEqual(start, -1, "Scene 3 stage block not found in demo/index.html");
  const end = html.indexOf('data-scene="4"', start);
  const scene3 = html.slice(start, end === -1 ? undefined : end);

  assert.match(scene3, /npx\s+secret-shuttle\s+init/, "Scene 3 must show `npx secret-shuttle init`");

  const forbidden: Array<{ re: RegExp; what: string }> = [
    { re: /npm\s+install\s+-g\s+secret-shuttle/, what: "`npm install -g secret-shuttle`" },
    { re: /secret-shuttle\s+daemon\s+start/, what: "`secret-shuttle daemon start`" },
    { re: /secret-shuttle\s+unlock/, what: "`secret-shuttle unlock`" },
  ];
  for (const { re, what } of forbidden) {
    assert.ok(
      !re.test(scene3),
      `Scene 3 must not contain the removed install ritual ${what} — use 'npx secret-shuttle init' instead.`,
    );
  }
});
```

- [ ] **Step 4: Build and run the guard — expect RED**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/e2e/docs-no-removed-verbs.test.js"`
Expected: FAIL on the still-broken demo, specifically:
- `drift-guard: demo/index.html …` — token scan hits `secret-shuttle generate` (demo line 1563).
- `demo: every \`secret-shuttle …\` invocation resolves …` — `doctor` (lines 1558, 1881) and `generate` (1563) do not resolve.
- `demo: Scene 3 install uses \`npx secret-shuttle init\` …` — Scene 3 still shows `npm install -g secret-shuttle` / `secret-shuttle daemon start` / `secret-shuttle unlock` and no `npx … init`.

This red state confirms the guard detects the drift. Now fix the demo.

- [ ] **Step 5: Fix Scene 0 copy (collapse 3-step → 2-step magic path)**

In `demo/index.html`, replace (line 1217):

```html
        <p class="copy"><code>provision --infer</code> reads <code>.env.example</code> + your framework configs (Vercel, Supabase, GitHub Actions) and writes a plan. <code>provision</code> mints one batch approval. You click <b>Approve</b> once in the hub. <code>provision --continue</code> ships every secret to every destination — and <code>audit</code> hands you the receipt.</p>
```

with:

```html
        <p class="copy"><code>provision --infer</code> reads <code>.env.example</code> + your framework configs (Vercel, Supabase, GitHub Actions), writes a plan, and mints one batch approval. You click <b>Approve</b> once in the hub. <code>provision --continue</code> ships every secret to every destination — and <code>audit</code> hands you the receipt.</p>
```

- [ ] **Step 6: Fix Scene 0 stage (fold `approval_required` into `--infer`, remove the bare `provision` group)**

Replace the two groups (lines 1361–1368):

```html
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">provision</span><span class="args">--infer</span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="dim">  Wrote secret-shuttle.yml — 3 secrets · vercel:production, supabase:&lt;ref&gt;</span></div>
            </div>
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">provision</span><span class="args"></span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="dim">  approval_required · batch b_8f3a… · 1 approval · </span><span class="em">opening hub →</span></div>
            </div>
```

with (a single `--infer` group whose result both writes the yml and returns `approval_required`):

```html
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">provision</span><span class="args">--infer</span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="dim">  Wrote secret-shuttle.yml — 3 secrets · vercel:production, supabase:&lt;ref&gt;</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="dim">  approval_required · batch b_8f3a… · 1 approval · </span><span class="em">opening hub →</span></div>
            </div>
```

- [ ] **Step 7: Fix Scene 3 copy (install line → `init`)**

Replace the title + copy (lines 1253–1254):

```html
        <h1 class="title">Install, daemon, <em>passphrase</em>.</h1>
        <p class="copy">Claude installs the package, starts the daemon, and calls <code>unlock</code>. The CLI never reads the passphrase. A local web window opens — the human types it directly into the daemon's UI.</p>
```

with:

```html
        <h1 class="title">One command, then <em>passphrase</em>.</h1>
        <p class="copy">Claude runs <code>npx secret-shuttle init</code> — one command that installs the daemon, starts it, and opens the passphrase window. The CLI never reads the passphrase. A local web window opens — the human types it directly into the daemon's UI.</p>
```

- [ ] **Step 8: Fix Scene 3 stage (three-command ritual → one `npx secret-shuttle init`)**

Replace the install groups + waiting group (lines 1476–1492):

```html
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(npm install -g secret-shuttle)</span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="dim">  + secret-shuttle@0.1.1</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="dim">  added 1 package in 3.2s</span></div>
            </div>
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle daemon start)</span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="json">  { <span class="k">"started"</span>: <span class="b">true</span>, <span class="k">"pid"</span>: <span class="n">8421</span> }</span></div>
            </div>
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle unlock)</span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="dim">  Opening unlock window in your browser…</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="dim">  (I cannot read the passphrase. Type it into the window →)</span></div>
            </div>
            <div class="group">
              <div class="line status">waiting<span class="cursor"></span></div>
            </div>
```

with:

```html
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(npx secret-shuttle init)</span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="json">  { <span class="k">"daemon"</span>: <span class="s">"started"</span>, <span class="k">"pid"</span>: <span class="n">8421</span> }</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="dim">  Opening passphrase window in your browser…</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="dim">  (I cannot read the passphrase. Type it into the window →)</span></div>
            </div>
            <div class="group">
              <div class="line status">waiting<span class="cursor"></span></div>
            </div>
```

(The unlock window block that follows, lines 1496–1507 — title "Unlock Secret Shuttle", "Create a vault passphrase", button "Create &amp; unlock" — is the accurate first-run passphrase-create moment and stays unchanged.)

- [ ] **Step 9: Fix Scene 4 copy + watch-for (`init` wrote the skill; `doctor` → `status`; reframe the per-agent line)**

Replace the copy (line 1266):

```html
        <p class="copy">One command writes the Secret Shuttle skill into the project. From here, the agent knows the order — <code>doctor</code> first, prefer <code>template run</code>, never log raw values, surface <code>manual_recovery_required</code> to the human.</p>
```

with:

```html
        <p class="copy"><code>init</code> already wrote the Secret Shuttle skill for detected agents. From here, the agent knows the order — <code>status</code> first, prefer <code>template run</code>, never log raw values, surface <code>manual_recovery_required</code> to the human.</p>
```

Then replace the watch-for (line 1267):

```html
        <div class="watch"><b>Watch for →</b> The same command exists for <code>codex</code>, <code>cursor</code>, <code>copilot</code> — marker-managed so it doesn't clobber the rest of the file.</div>
```

with:

```html
        <div class="watch"><b>Watch for →</b> Add more agents anytime: <code>secret-shuttle agent install codex</code> (also <code>cursor</code>, <code>copilot</code>) — marker-managed so it doesn't clobber the rest of the file.</div>
```

- [ ] **Step 10: Fix Scene 4 stage (reframe the `agent install claude` tool-call → `init` already wrote it; `doctor first` → `status first`)**

Replace the `agent install claude` group (lines 1519–1526):

```html
            <div class="group">
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle agent install claude)</span></div>
              <div class="line tool-result"><span class="glyph">⎿</span><span class="json">  {</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="json">    <span class="k">"written"</span>: <span class="s">".claude/skills/secret-shuttle/SKILL.md"</span>,</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="json">    <span class="k">"bytes"</span>: <span class="n">3481</span>,</span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="json">    <span class="k">"mode"</span>: <span class="s">"wholesale"</span></span></div>
              <div class="line tool-result" style="padding-left:14px"><span class="json">  }</span></div>
            </div>
```

with (an assistant observation that `init` already wrote the skill — no dead/renamed command, and `agent install claude` is no longer rendered as a freshly-run step since `init` covers detected runtimes):

```html
            <div class="group">
              <div class="line assistant"><span><code>init</code> already wrote my skill — <span class="em">.claude/skills/secret-shuttle/SKILL.md</span> (3,481 bytes; it detected a Claude project).</span></div>
            </div>
```

Then replace the assistant protocol line (line 1534):

```html
              <div class="line assistant"><span>Skill loaded. From here I'll follow the protocol — <span class="em">doctor first</span>, prefer template over browser, never log raw values, surface <span class="warn">manual_recovery_required</span> if the daemon can't prove the secret is gone.</span></div>
```

with:

```html
              <div class="line assistant"><span>Skill loaded. From here I'll follow the protocol — <span class="em">status first</span>, prefer template over browser, never log raw values, surface <span class="warn">manual_recovery_required</span> if the daemon can't prove the secret is gone.</span></div>
```

(The "Other agents are one command away" group on lines 1527–1531, which lists `secret-shuttle agent install codex|cursor|copilot`, is accurate and stays unchanged.)

- [ ] **Step 11: Fix Scene 5 copy (`doctor`, `generate` → `status`, `secrets set`)**

Replace the copy (line 1278):

```html
        <p class="copy">The dev asks for an <code>INTERNAL_CRON_SECRET</code> in prod, on Vercel. Claude runs <code>doctor</code>, <code>generate</code>, then <code>template run vercel-env-add</code>. Two approval cards in sequence — generate, then publish.</p>
```

with:

```html
        <p class="copy">The dev asks for an <code>INTERNAL_CRON_SECRET</code> in prod, on Vercel. Claude runs <code>status</code>, <code>secrets set</code>, then <code>template run vercel-env-add</code>. Two approval cards in sequence — generate, then publish.</p>
```

- [ ] **Step 12: Fix Scene 5 stage (`doctor --json` → `status --json`; `generate` → `secrets set`)**

Replace the `doctor` tool-call (line 1558):

```html
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle doctor --json)</span></div>
```

with:

```html
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle status --json)</span></div>
```

Then replace the `generate` tool-call first line (line 1563):

```html
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle generate \</span></div>
```

with:

```html
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle secrets set \</span></div>
```

(The continuation flag lines 1564–1567 — `--name INTERNAL_CRON_SECRET --env production`, `--kind random_32_bytes`, `--allow-domain vercel.com`, `--allow-action use_as_stdin` — are all valid `secrets set` options, including the `--allow-domain` that `set.ts:35-40` requires for production secrets, so they stay unchanged. The two approval cards and the `status` result lines 1559–1560 also stay.)

- [ ] **Step 13: Fix Scene 7 copy (DOM-scope the absence-proof claim)**

Replace the copy (line 1302):

```html
        <p class="copy">Claude calls <code>reveal-capture</code>. The daemon takes the wheel — blind mode engages, the daemon clicks reveal, captures the bytes from the marked scope, hides them, and proves the value is absent from every observable surface before resuming.</p>
```

with:

```html
        <p class="copy">Claude calls <code>reveal-capture</code>. The daemon takes the wheel — blind mode engages, the daemon clicks reveal, captures the bytes from the marked scope, hides them, and proves the value is absent from every surface the daemon can observe in the DOM before resuming.</p>
```

(Line 1302 is the only "every observable surface" phrasing in the demo. The remaining over-broad absence copy is the "verified gone" / "proves the secret is gone" wording — Scene 8's copy and approval cards (lines 1314, 1848, 1859) and Scene 7's approval cards (lines 1753, 1764) — all still broader than today's DOM scan, so they are DOM-scoped in Steps 13b and 13c.)

- [ ] **Step 13b: Fix Scene 8 copy + approval text (DOM-scope the absence-proof claim)**

The spec requires Scenes **7 and 8** to be DOM-scoped (Part 1 table, Scenes 7/8 row). Scene 8's "proves the secret is gone" / "verified gone" wording still claims a broader guarantee than today's synchronous DOM scan, so it is narrowed the same way Scene 7 was in Step 13.

Replace the Scene 8 copy (line 1314):

```html
        <p class="copy">Same browser, now on Vercel. Claude marks the value field + Save button, then calls <code>inject-submit</code> with a success marker. The daemon writes the secret, clicks save, waits for the marker, proves the secret is gone, and only then hands observation back.</p>
```

with:

```html
        <p class="copy">Same browser, now on Vercel. Claude marks the value field + Save button, then calls <code>inject-submit</code> with a success marker. The daemon writes the secret, clicks save, waits for the marker, proves the secret is gone from the DOM surfaces it can observe, and only then hands observation back.</p>
```

Then replace the Scene 8 approval-action text (line 1848):

```html
            <div class="approval-action">Inject <b>ss://stripe/prod/STRIPE_WEBHOOK_SECRET</b> into <b>value-field</b> on <b>vercel.com</b>, click <b>save-button</b>, wait for success, and auto-resume only if the secret is verified gone.</div>
```

with:

```html
            <div class="approval-action">Inject <b>ss://stripe/prod/STRIPE_WEBHOOK_SECRET</b> into <b>value-field</b> on <b>vercel.com</b>, click <b>save-button</b>, wait for success, and auto-resume only if the secret is verified gone from the daemon-observable DOM.</div>
```

Then replace the Scene 8 approval-warn text (line 1859):

```html
            <div class="approval-warn">Approving authorizes auto-resume only if the secret is verified gone (success and absence checks pass). If not, blind mode stays on.</div>
```

with:

```html
            <div class="approval-warn">Approving authorizes auto-resume only if the secret is verified gone from the daemon-observable DOM (success and absence checks pass). If not, blind mode stays on.</div>
```

(Scene 8's title on line 1311's block is a `scene-meta` heading; only the copy and the two approval strings above carry the over-broad absence claim. The Scene 7 approval cards on lines 1753/1764 carry the same over-broad "verified gone" claim and are DOM-scoped in Step 13c below — the spec's Scenes-7/8 row applies to all user-facing absence-proof copy in both scenes, including the approval cards.)

- [ ] **Step 13c: Fix Scene 7 approval text (DOM-scope the absence-proof claim)**

Scene 7's approval card is the `reveal-capture` flow's user-facing truthfulness copy. Its "verified gone" wording (the same over-broad absence claim narrowed in Scene 8) still promises more than today's synchronous DOM scan, so the spec's Scenes-7/8 DOM-scoping applies here too. Narrow it the same way.

Replace the Scene 7 approval-action text (line 1753):

```html
            <div class="approval-action">Click <b>reveal-btn</b> on <b>dashboard.stripe.com</b>, capture into <b>ss://stripe/prod/STRIPE_WEBHOOK_SECRET</b> (from <b>webhook-secret-field</b>, mode <code>field</code>), hide it, and auto-resume only if the secret is verified gone.</div>
```

with:

```html
            <div class="approval-action">Click <b>reveal-btn</b> on <b>dashboard.stripe.com</b>, capture into <b>ss://stripe/prod/STRIPE_WEBHOOK_SECRET</b> (from <b>webhook-secret-field</b>, mode <code>field</code>), hide it, and auto-resume only if the secret is verified gone from the daemon-observable DOM.</div>
```

Then replace the Scene 7 approval-warn text (line 1764):

```html
            <div class="approval-warn">Approving authorizes auto-resume only if the secret is verified gone (capture and absence checks pass). If not, blind mode stays on.</div>
```

with:

```html
            <div class="approval-warn">Approving authorizes auto-resume only if the secret is verified gone from the daemon-observable DOM (capture and absence checks pass). If not, blind mode stays on.</div>
```

(These are the only "verified gone" strings in Scene 7's approval card. The Scene 7 copy `<p class="copy">` on line 1302 was already DOM-scoped in Step 13; this step covers the approval card that Step 13's note had deferred.)

- [ ] **Step 14: Fix Scene 9 copy + stage + NAMES + comment (`doctor`/`Doctor` → `status`/`Status`)**

Replace the Scene 9 copy (line 1326):

```html
        <p class="copy">Doctor reports a clean state. The Stripe webhook signing secret is in Vercel production env. The dev never saw the raw value. The agent never saw it. No argv, no env, no log line, no chat transcript ever carried the bytes.</p>
```

with:

```html
        <p class="copy">Status reports a clean state. The Stripe webhook signing secret is in Vercel production env. The dev never saw the raw value. The agent never saw it. No argv, no env, no log line, no chat transcript ever carried the bytes.</p>
```

Replace the Scene 9 stage comment (line 1868):

```html
      <!-- Scene 9: terminal centered — doctor + summary -->
```

with:

```html
      <!-- Scene 9: terminal centered — status + summary -->
```

Replace the Scene 9 stage `doctor` tool-call (line 1881):

```html
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle doctor)</span></div>
```

with:

```html
              <div class="line tool-call"><span class="glyph">⏺</span><span class="tname">Bash</span><span class="args">(secret-shuttle status)</span></div>
```

(The result block lines 1882–1887 — daemon / vault / browser / policy / local files / agentic flows — matches `status` output and stays unchanged.)

Replace the `NAMES` array entry (line 1927):

```html
        "Doctor + done",
```

with:

```html
        "Status + done",
```

- [ ] **Step 15: Build and run the guard — expect GREEN**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/e2e/docs-no-removed-verbs.test.js"`
Expected: PASS — all per-DOC token-scan tests (now including `demo/index.html`), the registry command-path test, the Scene-3 install-shape test, and the `MOVED_TOKENS` adjacency test.

- [ ] **Step 16: Commit (guard + demo together)**

```bash
git add src/e2e/docs-no-removed-verbs.test.ts demo/index.html
git commit -m "fix(demo): retire removed verbs (doctor/generate), 2-step magic path, npx init install; extend drift-guard to cover the demo"
```

---

### Task 4: README truthfulness fixes

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Fix the install line (distinguish first-run passphrase from later Touch ID)**

Replace (line 39):

```markdown
This starts the local daemon and walks you through setting a vault passphrase. You will see a Touch ID prompt (macOS) or a passphrase entry window. The CLI never reads the passphrase — it is entered through a local web window that only the daemon owns. After `init` completes the daemon is running and you are ready to use the CLI or hand it to an agent.
```

with:

```markdown
This starts the local daemon and walks you through creating a vault passphrase in a local web window that only the daemon owns — the CLI never reads it. (Touch ID isn't a first-run prompt: it's how *later* unlocks work once the vault key is enrolled in the OS keychain. `init` enrols the keychain by default when it creates the vault — pass `--no-keychain` to opt out, or run `secret-shuttle keychain enable` later.) After `init` completes the daemon is running and you are ready to use the CLI or hand it to an agent.
```

- [ ] **Step 2: Add the shipped-but-unlisted verbs to "What Works Today (0.4.0)"**

Insert four bullets immediately after the migrate bullet (line 128, `- Migration command: \`secret-shuttle migrate secure-vault\``), before the `## What Does Not Work Yet` heading:

```markdown
- OS-keychain master-key storage (`secret-shuttle keychain enable|disable|status`) — `init` enrols the vault master key in the OS keychain by default when it creates the vault (opt out with `--no-keychain`); these subcommands enable/disable/inspect it afterwards, so later unlocks can use the system keychain / Touch ID instead of re-entering the passphrase
- `secret-shuttle secrets rotate <ref>` — generates a fresh secret and marks the old ref `rotating`; you then re-push the new value to its destinations and delete the old ref (it does not yet auto-re-push to existing bindings)
- `secret-shuttle import --env-file <path>` — import secrets from a `.env` file into the vault
- `secret-shuttle secrets delete <ref>` — remove a secret from the vault
```

- [ ] **Step 3: Narrow the "What Does Not Work Yet" entries that now ship**

Replace (line 132):

```markdown
- OS-keychain or hardware-backed key storage
```

with:

```markdown
- Hardware-backed key storage (HSM / Secure Enclave) — note: OS-keychain key storage *does* ship (see `keychain enable` above); this entry is only the hardware-backed tier
```

Replace (line 138):

```markdown
- Secret rotation / import / export workflows
```

with:

```markdown
- Secret export workflows (rotation and `.env` import ship; export does not)
```

- [ ] **Step 4: Build and run the full drift-guard — README must stay green**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/e2e/docs-no-removed-verbs.test.js"`
Expected: PASS. The new README bullets reference `keychain`, `secrets rotate`, `import`, `secrets delete` — none are removed/moved tokens — and the existing build-from-source `secret-shuttle daemon start` / `secret-shuttle unlock` lines remain fine (the Scene-3 install-shape check is demo-scoped, not applied to README).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): list shipped keychain/rotate/import/delete; fix Touch-ID first-run claim; narrow not-yet list to hardware-backed + export"
```

---

### Task 5: Full suite + manual demo verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS across the whole suite, including the four files this plan adds/extends:
- `dist/cli/build-program.test.js`
- `dist/e2e/demo-command-scan.test.js`
- `dist/e2e/docs-no-removed-verbs.test.js`
- the entrypoint subprocess tests (`cli-help-discoverability`, `bootstrap-removed`, `migrate`, `provision`).

- [ ] **Step 2: Manually verify the corrected demo renders the truthful copy**

Open `demo/index.html` in a browser at each edited scene and confirm the rendered commands/copy match:
- `?scene=0` — magic path reads as two `provision` steps (`--infer` then `--continue`); no bare `provision` row.
- `?scene=3` — install shows a single `npx secret-shuttle init`; passphrase window still says "Create & unlock".
- `?scene=4` — `init already wrote my skill`; protocol says "status first"; per-agent line shows `secret-shuttle agent install codex` (also cursor, copilot).
- `?scene=5` — `secret-shuttle status --json` then `secret-shuttle secrets set …` with the policy flags intact; two approval cards.
- `?scene=7` — copy reads "every surface the daemon can observe in the DOM"; both approval-card strings read "verified gone from the daemon-observable DOM".
- `?scene=8` — copy reads "proves the secret is gone from the DOM surfaces it can observe"; both approval cards read "verified gone from the daemon-observable DOM".
- `?scene=9` — "Status reports a clean state"; stage runs `secret-shuttle status`; scene name in the navigator reads "Status + done".

If a browser preview is unavailable, state that explicitly rather than claiming visual success; the drift-guard (Task 3 Step 15) and full suite (Step 1) are the authoritative automated checks.

---

## Self-Review

**1. Spec coverage**
- Part 1 (demo fixes): Scene 0 magic path → Steps 5–6; Scene 3 install → Steps 7–8; Scene 4 agent setup → Steps 9–10; Scene 5 generate/push → Steps 11–12; Scene 7 absence proof (copy → Step 13; both approval strings → Step 13c); Scene 8 absence proof (copy + both approval strings) → Step 13b; Scene 9 recap → Step 14. ✔
- Part 2 (README): install Touch-ID line → Task 4 Step 1; "What Works Today" additions (keychain, rotate, import, delete) → Step 2; "What Does Not Work Yet" narrowing → Step 3. ✔
- Part 3 (regression guard): Check 1 (demo added to token scan) → Task 3 Step 2; Check 2 (registry-backed command-path) → Steps 1 & 3 + the Task 2 helper; Check 3 (Scene-3 install-shape) → Step 3. The "side-effect-free `buildProgram()` prerequisite" → Task 1. The "unit test for the extracted `buildProgram()`" → Task 1 Step 1. ✔

**2. Placeholder scan** — no "TBD"/"add error handling"/"similar to Task N". Every code step shows full file contents or exact old→new strings; every run step shows the command and expected outcome. ✔

**3. Type/name consistency** — `buildProgram()` (Task 1) is imported with the same signature in Task 2's test and Task 3's guard. `extractShuttleInvocations` / `resolveCommandPath` / `PathResult` names match across `demo-command-scan.ts` (Task 2 Step 3), its test (Task 2 Step 1), and the guard (Task 3 Step 3). The Commander-internal reads (`registeredArguments`, `options`, `_allowUnknownOption`) use the same `as unknown as {…}` structural-view idiom already established in `src/cli/commands/secrets/secrets.test.ts`; the implementer note in Task 2 Step 3 flags the v12 field names so a rename trips the unit tests rather than silently weakening the guard. ✔

**4. Proven satisfiable** — every `secret-shuttle …` invocation in the demo was enumerated; after the Task-3 + Task-13b edits each resolves under the metadata-validating resolver (`status`, `status --json`, `secrets set`, `agent install <target>`, `browser mark pick --as <label>`, `browser start`, `reveal-capture`, `inject-submit`, `init`). No demo invocation uses `help <verb>` or exceeds a command's positional arity, so the tightened option-name/arity/`help`-passthrough checks reject none of the corrected lines. The only pre-fix failures are exactly the three the guard reports red (doctor ×2, generate). The corrected demo therefore turns the guard green without weakening it; the resolver's negative tests (extra positional, unknown option, `help doctor`) prove the guard would catch a future regression. ✔
