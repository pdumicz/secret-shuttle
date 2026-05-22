# Phase 1 — Plan 2: secrets group + status + internal namespace + help

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the user-facing CLI surface to match category conventions (op / doppler / infisical) — introduce the `secrets` command group (5 subcommands), rename `doctor` → `status`, move power-user commands under `internal`, add a deprecation layer that keeps old names working with stderr + JSON warnings, ship the new `secret-shuttle help` progressive-disclosure entry, and audit every command's `--help` to include a copy-pasteable example.

**Architecture:** Mostly additive + renames. The new `secrets` group wraps existing list/inspect/generate semantics under a Commander subcommand tree; two genuinely new commands (`delete`, `rotate`) each get a thin daemon endpoint that reuses existing vault and approval infrastructure. `status` reuses doctor's report-gathering logic and adds a `ready` boolean + `next_action` field. `internal` is a hidden Commander command group that absorbs only the power-user paths agents shouldn't see in default help: `compare`, `blind`, `capture`, and `inject` (V0). **`daemon`, `unlock`, and `migrate` all stay public at top level** — they're the recovery commands that Plan 1's registry hints (`daemon_not_running`, `vault_locked`, `legacy_key_present`, etc.) point at; relocating them under `internal` would break those hints and `status`'s `next_action`. A small deprecation helper handles the dual-channel warning. On success the human stderr line is emitted by `outputJson` and the JSON gets a `warning` field; on failure stderr stays JSON-only (the error JSON carries the `warning`) so it remains a single parseable document. Plus one cleanup: the three pre-handler error paths in `src/daemon/server.ts` get routed through `errorToJson` so every HTTP response emits the §5.6 contract uniformly.

**Tech Stack:** TypeScript (existing); Commander 12.x (existing); Node 20+ (existing); `node:test`. No new npm dependencies.

**Spec:** [docs/superpowers/specs/2026-05-21-agent-native-cli-redesign-design.md](../specs/2026-05-21-agent-native-cli-redesign-design.md) — primarily §3.2 (rename table), §3.3 (new commands), §4 (CLI surface enumeration), §5.2 (secrets group), §5.5 (status), §5.8 (help text design), §8.1–8.2 (migration + internal namespace).

**Sequence with other Phase 1 plans:**

- **Plan 1 ✅** — Foundation (structured errors + keychain stubs).
- **Plan 2 (this)** — CLI surface migration. Depends on Plan 1's error infrastructure.
- **Plan 3** — `run` + `inject` commands + daemon spawner. Depends on Plan 1; some overlap with Plan 2's `internal inject` deprecation that Plan 3 will resolve cleanly when the new `inject` lands.
- **Plan 4** — Pre-approved sessions + approval-UI tab reuse + `secrets set --kind paste`. Depends on Plan 1; consumes Plan 2's `secrets` group when adding paste mode.
- **Plan 5a** — `init` rewrite + native-module keychain.
- **Plan 5b** — Docs + npm publish 0.2.0.

## Scope reductions called out explicitly

These are spec items the plan deliberately defers, with rationale:

- **`secrets set --kind paste` mode** — §5.2 specifies a trusted browser-window paste flow. Requires new UI page + daemon endpoint + polling overlap with Plan 4's tab-reuse work. **Plan 2 ships `secrets set` as a rename of `generate` (random + capture); paste lands in Plan 4.** A `--kind paste` invocation errors with `unsupported_secret_kind` and copy pointing the caller at random kinds or `reveal-capture`. The error message **does not** mention internal plan numbers — agent-facing copy says what works now, not what's coming.
- **`secrets rotate` audit-log-driven destination discovery** — spec §5.2 step 3 has the daemon read `audit.jsonl` to find past destinations and synthesize a re-push plan. **Plan 2 ships rotate as: generate new + mark old as `rotating` + return `plan: []` with a `next_action` instructing the caller to re-push and then `secrets delete <old-ref>`.** Audit-log destination synthesis is a follow-up improvement.
- **Pre-existing `src/daemon/api/routes/unlock-session.ts:90` direct-emit** — Plan 1's final review flagged this. **Deferred to Plan 4** (which already touches the unlock/approval flow). Plan 2 fixes only the pre-handler paths in `server.ts`.

---

## File Structure

**Files to create:**

| Path | Purpose |
|---|---|
| `src/cli/commands/secrets/index.ts` | `secretsCommand()` — Commander group dispatcher, registers list/get-ref/set/delete/rotate |
| `src/cli/commands/secrets/list.ts` | `secretsListCommand()` — rename of current `list` |
| `src/cli/commands/secrets/get-ref.ts` | `secretsGetRefCommand()` — rename of current `inspect` |
| `src/cli/commands/secrets/set.ts` | `secretsSetCommand()` — rename of current `generate`; paste mode deferred |
| `src/cli/commands/secrets/delete.ts` | `secretsDeleteCommand()` — new |
| `src/cli/commands/secrets/rotate.ts` | `secretsRotateCommand()` — new (minimal scope) |
| `src/cli/commands/secrets/secrets.test.ts` | Group dispatcher + CLI argv parsing tests |
| `src/cli/commands/status.ts` | `statusCommand()` — rename of `doctor` with `ready` + `next_action` |
| `src/cli/commands/status.test.ts` | Status state-machine tests |
| `src/cli/commands/internal.ts` | `internalCommand()` — hidden Commander group; absorbs power-user commands |
| `src/cli/commands/help.ts` | `helpCommand()` — `secret-shuttle help [command]` progressive disclosure |
| `src/cli/commands/help.test.ts` | Help-output formatting tests |
| `src/cli/deprecation.ts` | `deprecated(oldName, newName, action)` helper — stderr + JSON warning |
| `src/cli/deprecation.test.ts` | Deprecation helper tests |
| `src/daemon/api/routes/secrets-delete.ts` | New daemon endpoint `POST /v1/secrets/delete` |
| `src/daemon/api/routes/secrets-rotate.ts` | New daemon endpoint `POST /v1/secrets/rotate` |
| `src/daemon/api/routes/secrets-delete.test.ts` | Delete-endpoint unit tests |
| `src/daemon/api/routes/secrets-rotate.test.ts` | Rotate-endpoint unit tests |

**Files to modify:**

| Path | Change |
|---|---|
| `src/cli/index.ts` | Register `secretsCommand`, `statusCommand`, `internalCommand`, `helpCommand`. Remove direct top-level registration of `compare`, `blind`, `capture`, `inject` (V0), `useAsStdin`. **Keep `daemon`, `unlock`, `migrate` registered at top level** — Plan 1 registry hints point at `daemon start/status`, `unlock`, and `migrate secure-vault` as recovery commands, and `status.next_action` returns those same literal strings. The old `list`/`inspect`/`generate`/`doctor` remain registered at top level as deprecated shims that delegate to their replacements. |
| `src/cli/commands/list.ts` | Stays as a deprecated shim — wraps `secretsListCommand` behavior with `deprecated('list','secrets list')`. |
| `src/cli/commands/inspect.ts` | Deprecated shim → `secrets get-ref`. |
| `src/cli/commands/generate.ts` | Deprecated shim → `secrets set`. |
| `src/cli/commands/doctor.ts` | Deprecated shim → `status`. Internal report-gathering logic stays exported for `statusCommand` to consume. |
| `src/cli/commands/use-as-stdin.ts` | **DELETE** (already documented as removed; readme/SKILL no longer reference it). |
| `src/daemon/server.ts` | Fix three pre-handler error paths (lines 88-92, 100-103, 109-112) to route through `errorToJson` so they emit the §5.6 contract. |
| `src/daemon/api/router.ts` *(or wherever routes are registered)* | Register `/v1/secrets/delete` and `/v1/secrets/rotate`. |
| `src/vault/vault.ts` | Add `softDelete(ref)` method + `markRotating(ref)` method. (Soft delete = vault record gets `deleted_at: ISO`; subsequent reads filter unless `--include-deleted`.) |
| `src/vault/types.ts` | Add `deleted_at?: string` to BOTH `SecretRecord` and `AgentSecretMetadata`. Add `rotating?: boolean` to `SecretRecord` (operational state only; not surfaced via the agent-facing metadata shape). |
| `CHANGELOG.md` | Append Plan 2 entries. |

**Files to delete:**

| Path | Reason |
|---|---|
| `src/cli/commands/use-as-stdin.ts` | Removed per README; replaced by `template run`. Plan 2 finalizes the deletion. |

---

## Pre-execution checklist — RUN BEFORE TASK A1

**This is a hard gate.** Do not proceed to Task A1 if any of these conditions fail. Plan 2's commit lineage must contain only files in this plan's declared scope — anything else is unrelated work that needs to be isolated FIRST.

- [ ] **Step 1: Working tree must be clean.**

```bash
git status --short
```

Expected output: empty (or only files this plan declares it will modify, but on a fresh execution the tree should be fully clean).

If anything appears:
- Files **inside this plan's scope** (e.g. `src/cli/commands/secrets/*`): unexpected — investigate; you might be re-running a partial execution.
- Files **outside this plan's scope** (e.g. `.claude/launch.json`, `demo/index.html`, etc.): commit them on a separate branch, stash them, or revert them. **Do not start Task A1 with unrelated dirty state.** Mixing scopes makes per-task reviews unreliable.

If you genuinely don't know whether a dirty file belongs to Plan 2 or to other work, STOP and escalate to the human.

- [ ] **Step 2: Confirm the head commit is one of Plan 2's plan-commits, not an unrelated commit interleaved in.**

```bash
git log --oneline -5
```

If recent commits include work unrelated to Plan 1's foundation or Plan 2's planning (e.g. demo / docs / unrelated fixes), that's fine for HISTORY but flag it in your execution report so the reviewer can untangle the diff when reviewing each Plan 2 commit. Don't reset/rebase those out — just note them.

- [ ] **Step 3: Confirm the build is green before any changes.**

```bash
npm run typecheck
npm test
```

Both must pass on the current HEAD. If they don't, the failure isn't caused by Plan 2 — fix or escalate before starting.

Once all three checks pass, proceed to Task A1.

---

## Part A — `secrets` command group

### Task A1: Register the `secrets` command group dispatcher

**Files:**
- Create: `src/cli/commands/secrets/index.ts`
- Create: `src/cli/commands/secrets/secrets.test.ts`
- Modify: `src/cli/index.ts` (add import + `program.addCommand(secretsCommand())`)

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/secrets/secrets.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { secretsCommand } from "./index.js";

test("secretsCommand registers all five subcommands", () => {
  const cmd = secretsCommand();
  const names = cmd.commands.map((c) => c.name()).sort();
  assert.deepEqual(names, ["delete", "get-ref", "list", "rotate", "set"]);
});

test("secretsCommand has the expected description", () => {
  const cmd = secretsCommand();
  assert.match(cmd.description(), /secret/i);
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run build && node --test "dist/cli/commands/secrets/secrets.test.js"
```

Expected: FAIL — `./index.js` doesn't exist.

- [ ] **Step 3: Implement the dispatcher**

Create `src/cli/commands/secrets/index.ts`:

```typescript
import { Command } from "commander";
import { secretsListCommand } from "./list.js";
import { secretsGetRefCommand } from "./get-ref.js";
import { secretsSetCommand } from "./set.js";
import { secretsDeleteCommand } from "./delete.js";
import { secretsRotateCommand } from "./rotate.js";

export function secretsCommand(): Command {
  const cmd = new Command("secrets")
    .description("Manage vault secrets (list, get-ref, set, delete, rotate). Raw values never returned.");

  cmd.addCommand(secretsListCommand());
  cmd.addCommand(secretsGetRefCommand());
  cmd.addCommand(secretsSetCommand());
  cmd.addCommand(secretsDeleteCommand());
  cmd.addCommand(secretsRotateCommand());

  return cmd;
}
```

The `./list.js`, `./get-ref.js`, etc. imports point at files created in Tasks A2–A6. **This task creates stub-level placeholder files** so the dispatcher compiles before its children are filled in. Create each as:

```typescript
// src/cli/commands/secrets/list.ts (and similar for get-ref/set/delete/rotate)
import { Command } from "commander";
export function secretsListCommand(): Command {
  return new Command("list").description("(placeholder — filled in by Task A2)");
}
```

Same shape for the other four files, with `secretsGetRefCommand`/`secretsSetCommand`/`secretsDeleteCommand`/`secretsRotateCommand` and subcommand names `get-ref` / `set` / `delete` / `rotate`.

- [ ] **Step 4: Register in `src/cli/index.ts`**

Open `src/cli/index.ts`. After the existing imports, add:

```typescript
import { secretsCommand } from "./commands/secrets/index.js";
```

After the existing `program.addCommand(...)` calls, add:

```typescript
program.addCommand(secretsCommand());
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
npm run build && node --test "dist/cli/commands/secrets/secrets.test.js"
```

Expected: PASS (2 tests).

- [ ] **Step 6: Smoke test — verify `secret-shuttle secrets --help` lists all five**

```bash
node dist/cli/index.js secrets --help 2>&1 | grep -E "list|get-ref|set|delete|rotate"
```

Expected: all five subcommand names appear.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/secrets/ src/cli/index.ts
git commit -m "feat(cli): register secrets command group dispatcher with five placeholder subcommands"
```

---

### Task A2: `secrets list` (rename of `list`)

**Files:**
- Modify: `src/cli/commands/secrets/list.ts` (replace placeholder with real impl)
- Modify: `src/cli/commands/secrets/secrets.test.ts` (append behavioral test)

- [ ] **Step 1: Append failing test to `secrets.test.ts`**

```typescript
test("secrets list accepts --env and --source options", () => {
  const cmd = secretsCommand();
  const list = cmd.commands.find((c) => c.name() === "list");
  assert.ok(list);
  const optionNames = list.options.map((o) => o.long);
  assert.ok(optionNames.includes("--env"), "list should accept --env");
  assert.ok(optionNames.includes("--source"), "list should accept --source");
});
```

- [ ] **Step 2: Run test — expect FAIL** (placeholder has no options)

- [ ] **Step 3: Implement** — replace `src/cli/commands/secrets/list.ts` with:

```typescript
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";

export function secretsListCommand(): Command {
  return new Command("list")
    .description("List secret metadata only. Raw values are never returned.")
    .option("--env <environment>", "Filter by environment (e.g. production, preview, local).")
    .option("--source <source>", "Filter by source (e.g. stripe, supabase, local).")
    .action(async (options) => {
      const body: Record<string, string> = {};
      if (options.env !== undefined) body.environment = options.env;
      if (options.source !== undefined) body.source = options.source;
      const r = await daemonRequest("POST", "/v1/secrets/list", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # List all secrets:
  secret-shuttle secrets list

  # Filter by environment:
  secret-shuttle secrets list --env production

  # Filter by source:
  secret-shuttle secrets list --source stripe
`);
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/secrets/list.ts src/cli/commands/secrets/secrets.test.ts
git commit -m "feat(cli): secrets list — rename of list, includes --help examples"
```

---

### Task A3: `secrets get-ref` (rename of `inspect`)

**Files:**
- Modify: `src/cli/commands/secrets/get-ref.ts` (replace placeholder)
- Modify: `src/cli/commands/secrets/secrets.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
test("secrets get-ref accepts a positional ref argument", () => {
  const cmd = secretsCommand();
  const getRef = cmd.commands.find((c) => c.name() === "get-ref");
  assert.ok(getRef);
  // Commander stores arguments in registeredArguments.
  const argNames = (getRef as unknown as { registeredArguments: { _name: string }[] })
    .registeredArguments.map((a) => a._name);
  assert.deepEqual(argNames, ["ref"]);
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement** — replace `src/cli/commands/secrets/get-ref.ts` with:

```typescript
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { normalizeRef } from "../helpers.js";

export function secretsGetRefCommand(): Command {
  return new Command("get-ref")
    .description("Show metadata for a stored secret. Raw values are never returned.")
    .argument("<ref>", "Secret ref (e.g. ss://stripe/prod/STRIPE_KEY).")
    .action(async (ref: string) => {
      const r = await daemonRequest("POST", "/v1/secrets/inspect", { ref: normalizeRef(ref) });
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Show metadata for a specific ref:
  secret-shuttle secrets get-ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET

Note: the raw secret value is never returned by this command. Output includes
the ref, fingerprint, allowed domains/actions, and timestamps — that's it.
`);
}
```

Note the import path: from `src/cli/commands/secrets/get-ref.ts` to `../helpers.js` (sibling of the secrets directory).

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/secrets/get-ref.ts src/cli/commands/secrets/secrets.test.ts
git commit -m "feat(cli): secrets get-ref — rename of inspect, includes --help examples"
```

---

### Task A4: `secrets set` (rename of `generate`)

**Files:**
- Modify: `src/cli/commands/secrets/set.ts` (replace placeholder)
- Modify: `src/cli/commands/secrets/secrets.test.ts`

Plan 2 ships `secrets set` as a behavior-preserving rename of `generate` (`--kind random_32_bytes` etc.). The `--kind paste` mode from spec §5.2 is deferred to Plan 4.

- [ ] **Step 1: Append failing test**

```typescript
test("secrets set requires --name and --env", () => {
  const cmd = secretsCommand();
  const set = cmd.commands.find((c) => c.name() === "set");
  assert.ok(set);
  const required = set.options.filter((o) => o.required).map((o) => o.long);
  assert.ok(required.includes("--name"), "set should require --name");
  assert.ok(required.includes("--env"), "set should require --env");
});

test("secrets set rejects --kind paste with a clear error (paste mode deferred to Plan 4)", () => {
  const cmd = secretsCommand();
  const set = cmd.commands.find((c) => c.name() === "set");
  assert.ok(set);
  // Just verify the kind option exists; behavioral rejection of "paste" is
  // covered by the action body (tested e2e in F1).
  const kind = set.options.find((o) => o.long === "--kind");
  assert.ok(kind);
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement** — replace `src/cli/commands/secrets/set.ts` with:

```typescript
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { collectRepeated } from "../helpers.js";
import { ShuttleError } from "../../../shared/errors.js";
import { canonicalEnvironment } from "../../../shared/refs.js";

export function secretsSetCommand(): Command {
  return new Command("set")
    .description("Store a new secret in the vault. Returns a ref; the value is never returned to the caller.")
    .requiredOption("--name <name>", "Logical secret name (e.g. STRIPE_WEBHOOK_SECRET).")
    .requiredOption("--env <environment>", "Environment (e.g. production, preview, local).")
    .option("--source <source>", "Source namespace (e.g. stripe, supabase, local).", "local")
    .option("--kind <kind>", "Generation kind: random_32_bytes | random_24_chars | ... (paste not yet supported)", "random_32_bytes")
    .option("--allow-domain <domain>", "Domain allow-list for inject (repeatable).", collectRepeated, [])
    .option("--allow-action <action>", "Allowed action (repeatable).", collectRepeated, [])
    .option("--description <description>", "Free-form description (stored in metadata).")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>", "Pre-issued approval id (skip the approval window).")
    .option("--no-wait", "Return approval_required without waiting.")
    .action(async (options) => {
      // Paste mode is not yet supported. (User-facing copy must NOT mention
      // internal plan numbers — say what works now.)
      if (options.kind === "paste") {
        throw new ShuttleError(
          "unsupported_secret_kind",
          "--kind paste is not yet supported. Use a random kind (e.g. --kind random_32_bytes) or capture from a provider page with 'reveal-capture'.",
        );
      }

      const domains = options.allowDomain as string[];
      if (canonicalEnvironment(options.env) === "production" && domains.length === 0) {
        throw new ShuttleError(
          "missing_allow_domain",
          "Production secrets require at least one --allow-domain.",
        );
      }
      const body: Record<string, unknown> = {
        name: options.name,
        environment: options.env,
        source: options.source,
        kind: options.kind,
        force: options.force === true,
        wait_for_approval: options.wait !== false,
      };
      if (domains.length > 0) body.allowed_domains = domains;
      const actions = options.allowAction as string[];
      if (actions.length > 0) body.allowed_actions = actions;
      if (options.description !== undefined) body.description = options.description;
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      const r = await daemonRequest("POST", "/v1/secrets/generate", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Generate a 32-byte random secret for production:
  secret-shuttle secrets set --name INTERNAL_CRON_SECRET --env production --kind random_32_bytes \\
    --allow-domain vercel.com

  # Generate a 24-char random secret for local dev:
  secret-shuttle secrets set --name DEV_SESSION_KEY --env local --kind random_24_chars

Exit codes:
  0  Success
  2  Usage error (missing required flag, bad --kind, etc.)
  4  Permission (approval denied, vault locked)
  5  Conflict (ref already exists; re-run with --force, or use 'secrets rotate' for explicit rotation)
`);
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/secrets/set.ts src/cli/commands/secrets/secrets.test.ts
git commit -m "feat(cli): secrets set — rename of generate; paste mode rejected with deferral hint"
```

---

### Task A5: `secrets delete` (new — CLI + daemon endpoint + invariant)

**Files:**
- Create: `src/daemon/api/routes/secrets-delete.ts`
- Create: `src/daemon/api/routes/secrets-delete.test.ts`
- Modify: `src/cli/commands/secrets/delete.ts` (replace placeholder)
- Modify: `src/cli/commands/secrets/secrets.test.ts`
- Modify: `src/vault/vault.ts` — add `softDelete(ref)`, extend existing `list({ environment, source, includeDeleted })` and `inspect(ref)` to filter deleted, update `getSecret(ref)` to throw `secret_not_found` for deleted refs
- Modify: `src/vault/vault.test.ts` (or wherever existing Vault tests live) — add tests for the invariant (incl. proof that `list({ includeDeleted: true })` returns `AgentSecretMetadata[]` with no `value` field)
- Modify: `src/vault/types.ts` — add `deleted_at?: string` to BOTH `SecretRecord` AND `AgentSecretMetadata` (so soft-deleted entries are distinguishable from active ones when surfaced via `--include-deleted`)
- Modify: `src/daemon/api/routes/secrets.ts` — `/v1/secrets/list` accepts `include_deleted: boolean` and threads it to `vault.list({...filters, includeDeleted})`; `/v1/secrets/inspect` returns `secret_not_found` for deleted refs (Vault.inspect change propagates automatically)
- Modify: `src/daemon/api/routes/secrets.test.ts` — add a test asserting `/v1/secrets/list { include_deleted: true }` never serializes a `value` field
- Modify: `src/cli/commands/secrets/list.ts` — add `--include-deleted` flag (CLI body sets `include_deleted: true`)
- Modify: `src/daemon/api/router.ts` — register `/v1/secrets/delete`
- Modify: `src/daemon/approvals/store.ts` — add `secrets_delete` to the `ApprovalBinding.action` union
- Modify: `src/daemon/approvals/ui.html` — add human-readable copy for `secrets_delete` action (mirror existing entries)

**Behavior + invariant:**

> **Default reads exclude soft-deleted records.** A record with a non-null `deleted_at` is treated as not present by every operational read path: `getSecret(ref)` throws `secret_not_found`; `/v1/secrets/list` omits them; `/v1/secrets/inspect` returns `secret_not_found`. The single exception is `/v1/secrets/list` when called with `include_deleted: true` (CLI: `secrets list --include-deleted`), which surfaces deleted records for admin / audit inspection.

This invariant is what makes "delete" actually behave like delete. Every downstream code path that consumes a ref (`inject`, `compare`, `template run`, `inject-submit`, `reveal-capture`, `secrets rotate`) goes through `getSecret` — so the invariant propagates automatically once `getSecret` filters.

Production refs require approval, gated through a new `secrets_delete` approval action with matching UI copy.

- [ ] **Step 1: Add `deleted_at?: string` to both `SecretRecord` and `AgentSecretMetadata`**

Open `src/vault/types.ts`. Both shapes get the same optional field so deleted entries remain identifiable when surfaced via `--include-deleted`:

```typescript
export interface SecretRecord {
  // ... existing fields
  deleted_at?: string; // ISO-8601 if soft-deleted; field absent otherwise.
}

export interface AgentSecretMetadata {
  // ... existing fields
  deleted_at?: string; // ISO-8601 if soft-deleted; field absent otherwise.
}
```

**Critical:** also update `toAgentMetadata` at `src/vault/vault.ts:193` so it copies `deleted_at` through (current implementation explicitly enumerates fields, which would strip the new one):

```typescript
export function toAgentMetadata(secret: SecretRecord): AgentSecretMetadata {
  return {
    id: secret.id,
    ref: secret.ref,
    name: secret.name,
    environment: secret.environment,
    source: secret.source,
    created_at: secret.created_at,
    updated_at: secret.updated_at,
    last_used_at: secret.last_used_at,
    fingerprint: secret.fingerprint,
    allowed_domains: [...secret.allowed_domains],
    allowed_actions: [...secret.allowed_actions],
    requires_approval: secret.requires_approval,
    classification: secret.classification,
    value_visible_to_agent: false,
    ...(secret.description !== undefined ? { description: secret.description } : {}),
    ...(secret.deleted_at !== undefined ? { deleted_at: secret.deleted_at } : {}),
  };
}
```

Without the spread for `deleted_at`, `secrets list --include-deleted` returns active and deleted entries that look identical — defeating the audit purpose of the flag.

If `SecretRecord` / `AgentSecretMetadata` are defined as Zod / similar schemas, adapt accordingly (add the optional field to both schemas).

- [ ] **Step 2: Update Vault — extend existing `list` + `inspect` + `getSecret` to filter deleted; add `softDelete`**

Open `src/vault/vault.ts`. Use the EXISTING metadata API:
- `getSecret(ref): Promise<SecretRecord>` at line 124 — returns the raw record (contains `value`); used by operational paths (inject, compare, template-run).
- `list(filters): Promise<AgentSecretMetadata[]>` at line 106 — returns metadata-only shape; used by `/v1/secrets/list`.
- `inspect(ref): Promise<AgentSecretMetadata>` at line 119 — returns metadata-only shape; used by `/v1/secrets/inspect`.

`AgentSecretMetadata` (types.ts:41) deliberately excludes the `value` field — it's the right shape for any external read path. **Do not introduce a new method that returns `SecretRecord[]` to callers; that would leak `value`.**

**Update the existing `getSecret(ref)` to throw on deleted:**

```typescript
async getSecret(ref: string): Promise<SecretRecord> {
  const plaintext = await this.read();
  const found = plaintext.secrets.find((s) => s.ref === ref);
  if (found === undefined || found.deleted_at !== undefined) {
    throw new ShuttleError("secret_not_found", `No secret with ref ${ref}.`);
  }
  return found;
}
```

(If the current implementation already uses a private lookup helper, apply the `deleted_at` check at that helper instead of duplicating it across callers.)

**Extend the existing `list(filters)` with `includeDeleted` — keep returning `AgentSecretMetadata[]`:**

```typescript
async list(
  filters: { environment?: string; source?: string; includeDeleted?: boolean } = {},
): Promise<AgentSecretMetadata[]> {
  const plaintext = await this.read();
  return plaintext.secrets
    .filter((s) => filters.includeDeleted === true || s.deleted_at === undefined)
    .filter((s) => filters.environment === undefined || s.environment === filters.environment)
    .filter((s) => filters.source === undefined || s.source === filters.source)
    .map((s) => toAgentMetadata(s));
}
```

(The existing filter chain in `list` should be adapted similarly — preserve whatever environment/source filtering shape is there today; only ADD the `includeDeleted` filter as the FIRST predicate in the chain. `toAgentMetadata(secret)` is at vault.ts:193 and is the existing function that strips `value`.)

**Extend the existing `inspect(ref)` to throw on deleted (same as `getSecret`):**

```typescript
async inspect(ref: string): Promise<AgentSecretMetadata> {
  const plaintext = await this.read();
  const found = plaintext.secrets.find((s) => s.ref === ref);
  if (found === undefined || found.deleted_at !== undefined) {
    throw new ShuttleError("secret_not_found", `No secret with ref ${ref}.`);
  }
  return toAgentMetadata(found);
}
```

**Add `softDelete(ref)` (public):**

```typescript
async softDelete(ref: string): Promise<{ ref: string; deleted_at: string }> {
  const plaintext = await this.read();
  const idx = plaintext.secrets.findIndex((s) => s.ref === ref);
  if (idx === -1 || plaintext.secrets[idx].deleted_at !== undefined) {
    throw new ShuttleError("secret_not_found", `No secret with ref ${ref}.`);
  }
  const now = new Date().toISOString();
  plaintext.secrets[idx] = { ...plaintext.secrets[idx], deleted_at: now };
  await this.write(plaintext);
  return { ref, deleted_at: now };
}
```

**Update the `/v1/secrets/list` route** (in `src/daemon/api/routes/secrets.ts`) to read `include_deleted` from the request body and pass it to `vault.list({...filters, includeDeleted})`. Existing tests should be unaffected since the default behavior (no `include_deleted` field) is unchanged.

**No changes needed to operational consumers:** inject / compare / template-run / inject-submit / reveal-capture all go through `getSecret(ref)` which now throws `secret_not_found` for deleted refs. The invariant propagates automatically.

- [ ] **Step 2b: Add `secrets_delete` to the ApprovalBinding action union**

Open `src/daemon/approvals/store.ts`. Find the `ApprovalBinding` interface (line 12). Extend the `action` union:

```typescript
export interface ApprovalBinding {
  action: "inject" | "capture" | "generate" | "compare" | "template" | "blind_end" | "inject_submit" | "reveal_capture" | "secrets_delete" | "secrets_rotate";
  // ... rest unchanged
}
```

(`secrets_rotate` is added preemptively here so Task A6 doesn't have to re-touch this file.)

Run the typecheck after this change to verify nothing else breaks (`npm run typecheck`). Any place that switches over `binding.action` will need a default case or a new branch.

- [ ] **Step 2c: Add UI copy for `secrets_delete` (and `secrets_rotate`) in `ui.html`**

Open `src/daemon/approvals/ui.html`. Find the action-to-human-copy mapping (likely a JS object literal or `switch` statement keyed by `g.action`). Add entries for the two new actions:

```javascript
// In whichever map / function builds the human-readable text from g.action:
case "secrets_delete":
  return "Delete the secret " + g.ref + " from the vault (audit trail preserved).";
case "secrets_rotate":
  return "Rotate the secret " + g.ref + ": generate a new value and mark the old as rotating.";
```

(Read the existing entries to match the file's style; the above is illustrative.)

If `ui.html` is too large or has changed since this plan was written, search for any string like `g.action ===` or `case "inject"` and add the two new entries alongside.

- [ ] **Step 2d: Vault invariant tests**

Open (or create) `src/vault/vault.test.ts`. Append tests:

```typescript
test("getSecret throws secret_not_found for a soft-deleted ref", async () => {
  const vault = await setUpTestVault({ secrets: [makeSecret("ss://x/dev/A")] });
  await vault.softDelete("ss://x/dev/A");
  await assert.rejects(
    () => vault.getSecret("ss://x/dev/A"),
    (err) => err instanceof ShuttleError && err.code === "secret_not_found",
  );
});

test("inspect throws secret_not_found for a soft-deleted ref (metadata API also blocked)", async () => {
  const vault = await setUpTestVault({ secrets: [makeSecret("ss://x/dev/A")] });
  await vault.softDelete("ss://x/dev/A");
  await assert.rejects(
    () => vault.inspect("ss://x/dev/A"),
    (err) => err instanceof ShuttleError && err.code === "secret_not_found",
  );
});

test("list excludes deleted by default; includeDeleted surfaces them as AgentSecretMetadata with deleted_at set", async () => {
  const vault = await setUpTestVault({
    secrets: [makeSecret("ss://x/dev/A"), makeSecret("ss://x/dev/B")],
  });
  await vault.softDelete("ss://x/dev/A");

  // Default list: deleted entry absent.
  const visible = await vault.list();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].ref, "ss://x/dev/B");
  assert.equal(visible[0].deleted_at, undefined, "active entry should NOT carry a deleted_at");

  // include-deleted: both entries present; the deleted one carries deleted_at.
  const all = await vault.list({ includeDeleted: true });
  assert.equal(all.length, 2);
  const deleted = all.find((s) => s.ref === "ss://x/dev/A");
  const active = all.find((s) => s.ref === "ss://x/dev/B");
  assert.ok(deleted, "deleted ref should surface with includeDeleted");
  assert.ok(typeof deleted.deleted_at === "string" && deleted.deleted_at.length > 0,
    "deleted entry must carry a non-empty ISO deleted_at so callers can distinguish it");
  assert.equal(active?.deleted_at, undefined, "active entry must NOT carry a deleted_at");

  // CRITICAL: even with includeDeleted, no `value` field — AgentSecretMetadata
  // shape doesn't have one, but assert defensively in case the type ever drifts.
  for (const entry of all) {
    assert.equal((entry as unknown as { value?: string }).value, undefined,
      "AgentSecretMetadata must never expose value, even with includeDeleted");
  }
});

test("softDelete on a non-existent ref throws secret_not_found", async () => {
  const vault = await setUpTestVault({ secrets: [] });
  await assert.rejects(
    () => vault.softDelete("ss://x/dev/missing"),
    (err) => err instanceof ShuttleError && err.code === "secret_not_found",
  );
});

test("softDelete a second time throws secret_not_found (already deleted)", async () => {
  const vault = await setUpTestVault({ secrets: [makeSecret("ss://x/dev/A")] });
  await vault.softDelete("ss://x/dev/A");
  await assert.rejects(
    () => vault.softDelete("ss://x/dev/A"),
    (err) => err instanceof ShuttleError && err.code === "secret_not_found",
  );
});
```

**Also add an endpoint-level test proving the wire never carries `value`:**

Append to `src/daemon/api/routes/secrets.test.ts` (or wherever `/v1/secrets/list` tests live):

```typescript
test("/v1/secrets/list with include_deleted: true returns metadata only and tags deleted entries", async () => {
  // Set up an ephemeral daemon with a vault containing one active + one deleted secret.
  // (Use the existing test harness — withDaemonAndVault or similar.)
  // ...
  const r = await daemonRequest("POST", "/v1/secrets/list", { include_deleted: true }) as {
    secrets: Array<{ ref: string; value?: string; deleted_at?: string }>;
    value_visible_to_agent: boolean;
  };

  // Route shape per src/daemon/api/routes/secrets.ts:67 is { secrets, value_visible_to_agent: false }.
  assert.equal(r.value_visible_to_agent, false, "list endpoint contract: value is never visible to agents");
  assert.ok(r.secrets.length >= 2, "should include both active and deleted entries");

  // No raw value field, ever, regardless of include_deleted.
  for (const item of r.secrets) {
    assert.equal(item.value, undefined,
      "the list endpoint must never serialize value, even with include_deleted");
  }

  // Deleted entries must be distinguishable from active ones via deleted_at.
  // (Without this assertion, --include-deleted would surface entries that
  // look identical to active ones — defeating the audit purpose.)
  const deleted = r.secrets.filter((s) => s.deleted_at !== undefined);
  const active = r.secrets.filter((s) => s.deleted_at === undefined);
  assert.ok(deleted.length >= 1, "at least one entry must carry deleted_at");
  assert.ok(active.length >= 1, "at least one entry must NOT carry deleted_at");
});

test("/v1/secrets/list without include_deleted omits deleted entries entirely", async () => {
  // Same fixture as above; verify default behavior.
  const r = await daemonRequest("POST", "/v1/secrets/list", {}) as {
    secrets: Array<{ ref: string; deleted_at?: string }>;
  };
  for (const item of r.secrets) {
    assert.equal(item.deleted_at, undefined,
      "default list must not include any entry with deleted_at set");
  }
});
```

(The test fixtures `setUpTestVault` and `makeSecret` should already exist or be findable in the vault test suite; if not, look at the existing test pattern in `src/vault/vault.test.ts` and follow it.)

- [ ] **Step 3: Daemon endpoint — write failing test**

Create `src/daemon/api/routes/secrets-delete.test.ts`. Use the existing daemon-test pattern (look at `src/daemon/api/routes/secrets.test.ts` for the harness; mirror it):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShuttleError } from "../../../shared/errors.js";
import { DaemonServer } from "../../server.js";
import { registerSecretsDeleteRoute } from "./secrets-delete.js";
import { writeSocketFile } from "../../socket-file.js";
import { daemonRequest } from "../../../client/daemon-client.js";

// (Same withEphemeralDaemon pattern from src/client/daemon-client.test.ts —
// copy that helper structure and set up a stubbed vault.)

test("POST /v1/secrets/delete returns { ref, deleted_at } when ref exists", async () => {
  // Set up an ephemeral daemon with a stub vault that contains one ref.
  // (Full harness code mirrors src/daemon/api/routes/secrets.test.ts — adapt.)
  // After the call, vault.read() should show the ref with deleted_at set.
});

test("POST /v1/secrets/delete throws secret_not_found if ref does not exist", async () => {
  // Daemon returns ok:false with the secret_not_found code.
});

test("POST /v1/secrets/delete production refs require approval", async () => {
  // Without --approval-id, the call returns approval_required.
});
```

**Note for the implementer:** the test harness for daemon routes is non-trivial. Read `src/daemon/api/routes/secrets.test.ts` carefully and mirror its structure. If that file is large/complex, the harness probably uses a `withDaemonAndVault` helper — find it and reuse.

- [ ] **Step 4: Implement the endpoint**

Create `src/daemon/api/routes/secrets-delete.ts`:

```typescript
import type { IncomingMessage } from "node:http";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { DaemonServices } from "../../services.js";

interface DeleteBody {
  ref?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}

interface RouteRegistrar {
  addRoute: (
    method: "POST",
    path: string,
    handler: (req: IncomingMessage, body: unknown) => Promise<unknown>,
  ) => void;
}

export function registerSecretsDeleteRoute(
  server: RouteRegistrar,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/secrets/delete", async (_req, body) => {
    const b = (body ?? {}) as DeleteBody;
    if (typeof b.ref !== "string" || b.ref.length === 0) {
      throw new ShuttleError("missing_param", "ref is required.");
    }

    // Use the public getSecret() — it throws secret_not_found for both
    // missing AND already-soft-deleted refs (per the invariant). This
    // doubles as our existence check + production-or-not branch input.
    const record = await services.vault.getSecret(b.ref);

    // Production-gated.
    if (record.environment === "production") {
      const binding: ApprovalBinding = {
        action: "secrets_delete",
        ref: b.ref,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: record.allowed_domains ?? [],
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        approvalIdFromClient: b.approval_id,
        waitMs: b.wait_for_approval === false ? 0 : undefined,
      });
    }

    const result = await services.vault.softDelete(b.ref);
    return { deleted: true, ref: result.ref, deleted_at: result.deleted_at };
  });
}
```

**Note on signature:** `DaemonServices` (services.ts:41) doesn't have a `daemonPort` field — the port is owned by the listening `DaemonServer` and threaded into routes as a `daemonPortRef: () => number` from the router. Look at any existing route file (e.g. `src/daemon/api/routes/secrets.ts`) to confirm the registrar pattern and match it exactly — `registerSecretsDeleteRoute(server, services, daemonPortRef)` should match the surrounding convention.

**Note on `ApprovalBinding` shape:** the type at `src/daemon/approvals/store.ts:12` has optional fields beyond what's shown above (e.g. `template_binary_path`, `submit_fingerprint`, etc.). Only set the fields that matter for this binding's match semantics; leave the rest unset. The `bindingsMatch` logic in `store.ts` compares using strict-equality on the declared fields and stable-set on `allowed_domains`.

- [ ] **Step 5: Register the route**

Open `src/daemon/api/router.ts` (the file that wires routes to the server). Add:

```typescript
import { registerSecretsDeleteRoute } from "./routes/secrets-delete.js";
// ... in the function that registers routes (which already receives
// daemonPortRef from the lifecycle code that owns the listening server):
registerSecretsDeleteRoute(server, services, daemonPortRef);
```

(If the project uses a different route-registration pattern, follow that pattern.)

- [ ] **Step 6: Run daemon-side test — expect PASS**

```bash
npm run build && node --test "dist/daemon/api/routes/secrets-delete.test.js"
```

- [ ] **Step 7: CLI side — append failing test**

In `src/cli/commands/secrets/secrets.test.ts`:

```typescript
test("secrets delete takes a positional <ref> argument", () => {
  const cmd = secretsCommand();
  const del = cmd.commands.find((c) => c.name() === "delete");
  assert.ok(del);
  const argNames = (del as unknown as { registeredArguments: { _name: string }[] })
    .registeredArguments.map((a) => a._name);
  assert.deepEqual(argNames, ["ref"]);
});
```

- [ ] **Step 8: Implement the CLI** — replace `src/cli/commands/secrets/delete.ts` with:

```typescript
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { normalizeRef } from "../helpers.js";

export function secretsDeleteCommand(): Command {
  return new Command("delete")
    .description("Soft-delete a secret. Audit trail preserved. Production refs require approval.")
    .argument("<ref>", "Secret ref to delete (e.g. ss://stripe/prod/STRIPE_KEY).")
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--no-wait", "Return approval_required without waiting.")
    .action(async (ref: string, options) => {
      const body: Record<string, unknown> = { ref: normalizeRef(ref) };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.wait === false) body.wait_for_approval = false;
      const r = await daemonRequest("POST", "/v1/secrets/delete", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Soft-delete a secret (audit trail kept):
  secret-shuttle secrets delete ss://stripe/prod/STRIPE_WEBHOOK_SECRET

Notes:
  - Soft delete sets a 'deleted_at' field on the vault record. The record
    stays in the vault file but is filtered from default 'secrets list' output.
  - Production refs require approval. Use --no-wait to receive an approval_id
    immediately and supply it via --approval-id once approved.
`);
}
```

- [ ] **Step 9: Run CLI tests + smoke test**

```bash
npm run build && node --test "dist/cli/commands/secrets/secrets.test.js"
node dist/cli/index.js secrets delete --help
```

- [ ] **Step 10: Commit**

```bash
git add src/vault/types.ts src/vault/vault.ts \
  src/daemon/api/routes/secrets-delete.ts src/daemon/api/routes/secrets-delete.test.ts \
  src/daemon/api/router.ts \
  src/cli/commands/secrets/delete.ts src/cli/commands/secrets/secrets.test.ts
git commit -m "feat(cli): secrets delete — soft delete with audit trail, production-gated"
```

---

### Task A6: `secrets rotate` (new — minimal scope)

**Files:**
- Create: `src/daemon/api/routes/secrets-rotate.ts`
- Create: `src/daemon/api/routes/secrets-rotate.test.ts`
- Modify: `src/cli/commands/secrets/rotate.ts` (replace placeholder)
- Modify: `src/cli/commands/secrets/secrets.test.ts`
- Modify: `src/vault/vault.ts` — add `markRotating(ref)` method
- Modify: `src/vault/types.ts` — add `rotating?: boolean` field
- Modify: `src/daemon/api/router.ts` — register `/v1/secrets/rotate`

**Minimal scope (per Scope Reductions section):** rotate generates a new ref + marks old as `rotating`. Returns `{ new_ref, old_ref, plan: [], next_action: "..." }`. Audit-log destination synthesis is deferred.

- [ ] **Step 1: Add `rotating?: boolean` to SecretRecord**

Open `src/vault/types.ts`. Extend SecretRecord:

```typescript
export interface SecretRecord {
  // ... existing fields including deleted_at from Task A5
  rotating?: boolean; // true if a newer ref has superseded this one but it hasn't been deleted yet.
}
```

- [ ] **Step 2: Add `markRotating(ref)` to Vault**

In `src/vault/vault.ts`:

```typescript
async markRotating(ref: string): Promise<void> {
  const plaintext = await this.read();
  const idx = plaintext.secrets.findIndex((s) => s.ref === ref);
  if (idx === -1) {
    throw new ShuttleError("secret_not_found", `No secret with ref ${ref}.`);
  }
  plaintext.secrets[idx] = { ...plaintext.secrets[idx], rotating: true };
  await this.write(plaintext);
}
```

- [ ] **Step 3: Daemon endpoint — failing test**

Create `src/daemon/api/routes/secrets-rotate.test.ts`. Mirror the test harness pattern from secrets-delete.test.ts (Task A5). Tests:

```typescript
test("POST /v1/secrets/rotate generates a new ref and marks the old as rotating", async () => {
  // Setup: vault has one ref. Call rotate. Verify:
  // - Response includes new_ref, old_ref, plan: [], next_action.
  // - Vault now has TWO entries: old (rotating: true) and new (rotating: undefined).
});

test("POST /v1/secrets/rotate fails with secret_not_found if old ref does not exist", async () => {
  // Daemon returns ok:false with the secret_not_found code.
});

test("POST /v1/secrets/rotate production refs require approval", async () => {
  // Without --approval-id, returns approval_required.
});
```

- [ ] **Step 4: Implement endpoint**

Create `src/daemon/api/routes/secrets-rotate.ts`:

```typescript
import type { IncomingMessage } from "node:http";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { DaemonServices } from "../../services.js";

interface RotateBody {
  ref?: string;
  kind?: string; // generation kind for the new secret; defaults to random_32_bytes
  approval_id?: string;
  wait_for_approval?: boolean;
}

interface RouteRegistrar {
  addRoute: (
    method: "POST",
    path: string,
    handler: (req: IncomingMessage, body: unknown) => Promise<unknown>,
  ) => void;
}

export function registerSecretsRotateRoute(
  server: RouteRegistrar,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/secrets/rotate", async (_req, body) => {
    const b = (body ?? {}) as RotateBody;
    if (typeof b.ref !== "string" || b.ref.length === 0) {
      throw new ShuttleError("missing_param", "ref is required.");
    }

    // Public getSecret enforces the soft-delete invariant: rotating an
    // already-deleted ref is secret_not_found, which is correct.
    const oldRecord = await services.vault.getSecret(b.ref);
    const kind = typeof b.kind === "string" ? b.kind : "random_32_bytes";

    // Production-gated. ApprovalBinding.action gained "secrets_rotate" in
    // Task A5 step 2b (added alongside secrets_delete for the same TS pass).
    if (oldRecord.environment === "production") {
      const binding: ApprovalBinding = {
        action: "secrets_rotate",
        ref: b.ref,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: oldRecord.allowed_domains ?? [],
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        approvalIdFromClient: b.approval_id,
        waitMs: b.wait_for_approval === false ? 0 : undefined,
      });
    }

    // Generate the new secret via the same code path the existing
    // /v1/secrets/generate route uses. If services.vault doesn't expose a
    // direct `generate` method, look at how `secrets.ts` (the generate
    // route) builds its record — factor that into a shared helper and call
    // it from both places. Don't duplicate generation logic.
    const rotSuffix = `-rot-${Date.now().toString(36)}`;
    const newName = oldRecord.name + rotSuffix;
    const newRecord = await services.vault.generate({
      name: newName,
      environment: oldRecord.environment,
      source: oldRecord.source,
      kind,
      allowed_domains: oldRecord.allowed_domains,
      allowed_actions: oldRecord.allowed_actions,
      description: `Rotation of ${b.ref} on ${new Date().toISOString()}`,
    });

    await services.vault.markRotating(b.ref);

    return {
      rotation_started: true,
      old_ref: b.ref,
      new_ref: newRecord.ref,
      plan: [], // Empty in this release; destination synthesis from audit log is a follow-up.
      next_action: `Re-push the new secret to all destinations of ${b.ref}, then run: secret-shuttle secrets delete ${b.ref}`,
    };
  });
}
```

**Note on `services.vault.generate(...)`:** the existing daemon `/v1/secrets/generate` route already has the canonical generation code. If `vault` doesn't already expose a `generate` method matching this signature, the implementer must (a) extract the generation logic from `secrets.ts`'s `/v1/secrets/generate` handler into a `Vault.generate(...)` method, (b) call it from both the existing route and from this new rotate route. Don't duplicate generation logic across two files.

- [ ] **Step 5: Register route**

In the route-registration site (same place that received the A5 change), add:

```typescript
import { registerSecretsRotateRoute } from "./routes/secrets-rotate.js";
// ...
registerSecretsRotateRoute(server, services, daemonPortRef);
```

Pass the same `daemonPortRef: () => number` that the router already threads through to existing routes.

- [ ] **Step 6: Run daemon tests — expect PASS**

- [ ] **Step 7: CLI side — failing test**

```typescript
test("secrets rotate takes a positional <ref> argument and --kind option", () => {
  const cmd = secretsCommand();
  const rot = cmd.commands.find((c) => c.name() === "rotate");
  assert.ok(rot);
  const argNames = (rot as unknown as { registeredArguments: { _name: string }[] })
    .registeredArguments.map((a) => a._name);
  assert.deepEqual(argNames, ["ref"]);
  const optionNames = rot.options.map((o) => o.long);
  assert.ok(optionNames.includes("--kind"));
});
```

- [ ] **Step 8: Implement CLI** — replace `src/cli/commands/secrets/rotate.ts`:

```typescript
import { Command } from "commander";
import { daemonRequest } from "../../../client/daemon-client.js";
import { ok, outputJson } from "../../../shared/result.js";
import { normalizeRef } from "../helpers.js";

export function secretsRotateCommand(): Command {
  return new Command("rotate")
    .description("Rotate a secret. Generates a new ref, marks the old one as rotating. Caller re-pushes and then deletes the old.")
    .argument("<ref>", "Secret ref to rotate.")
    .option("--kind <kind>", "Generation kind for the new secret.", "random_32_bytes")
    .option("--approval-id <id>", "Pre-issued approval id.")
    .option("--no-wait", "Return approval_required without waiting.")
    .action(async (ref: string, options) => {
      const body: Record<string, unknown> = {
        ref: normalizeRef(ref),
        kind: options.kind,
      };
      if (options.approvalId !== undefined) body.approval_id = options.approvalId;
      if (options.wait === false) body.wait_for_approval = false;
      const r = await daemonRequest("POST", "/v1/secrets/rotate", body);
      outputJson(ok(r as Record<string, unknown>));
    })
    .addHelpText("after", `
Examples:
  # Rotate a webhook secret:
  secret-shuttle secrets rotate ss://stripe/prod/STRIPE_WEBHOOK_SECRET

Output (excerpt):
  {
    "ok": true,
    "rotation_started": true,
    "old_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
    "new_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET-rot-<id>",
    "plan": [],
    "next_action": "Re-push the new secret to all destinations ..."
  }

Workflow (full rotation):
  1. Run 'secrets rotate <ref>' — returns new_ref.
  2. Push new_ref to every destination (Vercel env, GitHub Actions, etc.)
     via 'template run' or 'inject-submit'.
  3. Once all pushes succeed, run 'secrets delete <old-ref>'.

Note: 'plan' is empty in this release. A future release will read the audit
log to suggest specific re-push commands per destination.
`);
}
```

- [ ] **Step 9: Run CLI tests + smoke test**

- [ ] **Step 10: Commit**

```bash
git add src/vault/types.ts src/vault/vault.ts \
  src/daemon/api/routes/secrets-rotate.ts src/daemon/api/routes/secrets-rotate.test.ts \
  src/daemon/api/router.ts \
  src/cli/commands/secrets/rotate.ts src/cli/commands/secrets/secrets.test.ts
git commit -m "feat(cli): secrets rotate — generate new + mark old rotating; empty plan for now"
```

---

## Part B — `status` rename

### Task B1: `status` command (rename of `doctor`)

**Files:**
- Create: `src/cli/commands/status.ts`
- Create: `src/cli/commands/status.test.ts`
- Modify: `src/cli/index.ts` (register `statusCommand()`)

**Behavior:** `status` extends `doctor` by emitting a top-level `ready: boolean` and `next_action: string | null` (per spec §5.5). The existing `DoctorReport` shape is preserved inside a `report` field for back-compat / power use. Text-mode output also includes the new fields.

The original `doctor` command becomes a deprecated shim in Part C (deprecation layer).

- [ ] **Step 1: Write failing tests**

Create `src/cli/commands/status.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatusFromReport } from "./status.js";

test("status: daemon unreachable → ready=false, next_action points at daemon start", () => {
  const report = {
    daemon_reachable: false,
    daemon_error: "ECONNREFUSED",
    socket_file_mode: null,
    socket_file_mode_ok: true,
    health: null,
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, false);
  assert.equal(result.next_action, "secret-shuttle daemon start");
});

test("status: daemon reachable but vault locked → ready=false, next_action=unlock", () => {
  const report = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      unlocked: false,
      browser_started: false,
      proxy_active: false,
      blind_mode: null,
      vault: { envelope_present: true, legacy_key_present: false },
      policy_warnings: null,
    },
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, false);
  assert.equal(result.next_action, "secret-shuttle unlock");
});

test("status: vault locked but legacy_key_present → next_action points at migrate", () => {
  const report = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      unlocked: false,
      browser_started: false,
      proxy_active: false,
      blind_mode: null,
      vault: { envelope_present: false, legacy_key_present: true },
      policy_warnings: null,
    },
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, false);
  assert.equal(result.next_action, "secret-shuttle migrate secure-vault");
});

test("status: everything green → ready=true, next_action=null", () => {
  const report = {
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      unlocked: true,
      browser_started: true,
      proxy_active: true,
      blind_mode: null,
      vault: { envelope_present: true, legacy_key_present: false },
      policy_warnings: [],
    },
  };
  const result = computeStatusFromReport(report);
  assert.equal(result.ready, true);
  assert.equal(result.next_action, null);
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/cli/commands/status.ts`:

```typescript
import { Command } from "commander";
import { stat } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { getShuttlePaths } from "../../shared/config.js";
import { ok, outputJson } from "../../shared/result.js";
import { formatDoctorText, type DoctorReport } from "./doctor.js";

export interface StatusResult {
  ready: boolean;
  next_action: string | null;
  report: DoctorReport;
}

/**
 * Derive the `ready` boolean + `next_action` from a DoctorReport. Pure
 * function — exported for unit testing.
 */
export function computeStatusFromReport(report: DoctorReport): { ready: boolean; next_action: string | null } {
  if (!report.daemon_reachable) {
    return { ready: false, next_action: "secret-shuttle daemon start" };
  }
  const health = report.health;
  if (health === null) {
    return { ready: false, next_action: "secret-shuttle daemon start" };
  }
  const vault = health.vault as { envelope_present: boolean; legacy_key_present: boolean } | undefined;
  if (vault?.legacy_key_present === true) {
    return { ready: false, next_action: "secret-shuttle migrate secure-vault" };
  }
  if (health.unlocked !== true) {
    return { ready: false, next_action: "secret-shuttle unlock" };
  }
  return { ready: true, next_action: null };
}

export function statusCommand(): Command {
  return new Command("status")
    .description("Report daemon, vault, browser, and policy health. Emits ready+next_action for agents.")
    .option("--json", "Emit machine-readable JSON.", false)
    .action(async (options) => {
      const paths = getShuttlePaths();
      let socketMode: string | null = null;
      try {
        const st = await stat(paths.daemonSocketPath);
        socketMode = "0" + (st.mode & 0o777).toString(8);
      } catch {
        socketMode = null;
      }

      let health: Record<string, unknown> | null = null;
      let daemonError: string | null = null;
      try {
        health = (await daemonRequest("GET", "/v1/health")) as Record<string, unknown>;
      } catch (e) {
        daemonError = e instanceof Error ? e.message : String(e);
      }

      const report: DoctorReport = {
        daemon_reachable: health !== null,
        daemon_error: daemonError,
        socket_file_mode: socketMode,
        socket_file_mode_ok: socketMode === null || socketMode === "0600",
        health,
      };

      const { ready, next_action } = computeStatusFromReport(report);
      const result: StatusResult = { ready, next_action, report };

      if (options.json === true || !process.stdout.isTTY) {
        outputJson(ok(result as unknown as Record<string, unknown>));
        return;
      }

      // Text mode: lead with ready + next_action, then the doctor-style report.
      process.stdout.write(`ready:         ${ready}\n`);
      if (next_action !== null) {
        process.stdout.write(`next_action:   ${next_action}\n`);
      }
      process.stdout.write("\n");
      process.stdout.write(formatDoctorText(report));
    })
    .addHelpText("after", `
Examples:
  # Human-readable health summary:
  secret-shuttle status

  # Machine-readable JSON (default when stdout is not a TTY):
  secret-shuttle status --json

Output shape (JSON):
  {
    "ok": true,
    "ready": true | false,
    "next_action": "secret-shuttle <command>" | null,
    "report": { daemon_reachable, daemon_error, socket_file_mode, health }
  }
`);
}
```

- [ ] **Step 4: Register in `src/cli/index.ts`**

Add `import { statusCommand } from "./commands/status.js"` and `program.addCommand(statusCommand())`.

- [ ] **Step 5: Run tests — expect PASS**

```bash
npm run build && node --test "dist/cli/commands/status.test.js"
```

Expected: 4 tests pass.

- [ ] **Step 6: Smoke test**

```bash
node dist/cli/index.js status --json
node dist/cli/index.js status --help
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/status.ts src/cli/commands/status.test.ts src/cli/index.ts
git commit -m "feat(cli): status — rename of doctor with ready boolean + next_action for agents"
```

---

## Part C — `internal` namespace + deprecation

### Task C1: Deprecation helper

**Files:**
- Create: `src/cli/deprecation.ts`
- Create: `src/cli/deprecation.test.ts`

**Behavior:** wraps a Commander action so that invoking the deprecated command sets a process-wide pending warning. Where the warning surfaces depends on outcome:

| Outcome | stderr | stdout |
|---|---|---|
| Success (action reaches `outputJson`) | Human line: `[deprecated] '<old>' is now '<new>'. Will be removed in v0.3.0.` | JSON includes top-level `warning: { message, deprecated, replacement }` |
| Failure (action throws before `outputJson`) | Single JSON document — error JSON with the same `warning` field spliced in. **No separate human line.** | (empty) |

This split keeps stderr machine-parseable on failure (a single JSON document) while still showing humans the deprecation line on success. The setter itself writes nothing — only the two consumers (`outputJson` for success, CLI catch for failure) emit anything.

Implementation strategy: `outputJson` already exists in `src/shared/result.ts`. We extend it (or add `outputJsonWithWarning`) to accept an optional warning. The `deprecated()` helper sets a context flag that `outputJson` reads.

For simplicity and DRY, use a module-level "pending warning" set by `deprecated()`, consumed by `outputJson` on the next call, then cleared. Single-threaded Node CLI process → safe.

- [ ] **Step 1: Failing tests**

Create `src/cli/deprecation.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPendingDeprecationWarning, consumePendingDeprecationWarning } from "./deprecation.js";

test("withPendingDeprecationWarning sets pending; consume retrieves once", () => {
  consumePendingDeprecationWarning(); // start clean
  withPendingDeprecationWarning("list", "secrets list");
  const w = consumePendingDeprecationWarning();
  assert.deepEqual(w, {
    message: "[deprecated] 'list' is now 'secrets list'. Will be removed in v0.3.0.",
    deprecated: "list",
    replacement: "secrets list",
  });
  // Second consume returns null.
  assert.equal(consumePendingDeprecationWarning(), null);
});

test("withPendingDeprecationWarning does NOT write to stderr (consumer owns emission)", () => {
  // Critical contract: the failure-path consumer (CLI catch) must NOT cause
  // a duplicate stderr human line. The setter never writes stderr; only the
  // success-path consumer (outputJson) writes the human line on stderr.
  // Capture stderr to prove it.
  consumePendingDeprecationWarning(); // start clean
  const captured: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    withPendingDeprecationWarning("list", "secrets list");
  } finally {
    process.stderr.write = origWrite;
  }
  assert.deepEqual(captured, [], "withPendingDeprecationWarning must not write to stderr");
  consumePendingDeprecationWarning(); // clean up
});

test("consume without set returns null", () => {
  consumePendingDeprecationWarning(); // reset
  assert.equal(consumePendingDeprecationWarning(), null);
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/cli/deprecation.ts`:

```typescript
export interface DeprecationWarning {
  message: string;
  deprecated: string;
  replacement: string;
}

let pending: DeprecationWarning | null = null;

/**
 * Mark a deprecation warning to be emitted with the next outputJson() call.
 *
 * Contract:
 *  - On success path (outputJson is reached): outputJson writes the human
 *    line to stderr AND splices `warning` into the JSON output on stdout.
 *  - On failure path (an error is thrown before outputJson): the CLI's catch
 *    block in src/cli/index.ts consumes the pending warning, splices it
 *    into the error JSON, and writes ONLY the error JSON to stderr. NO
 *    human line is written on the failure path, so stderr stays a single
 *    parseable JSON document for machine consumers.
 *
 * This function only flips the in-process flag — it does NOT write anything
 * to stderr or stdout. The two consume sites (outputJson and the CLI catch)
 * decide what to emit and where.
 */
export function withPendingDeprecationWarning(oldName: string, newName: string): void {
  const warning: DeprecationWarning = {
    message: `[deprecated] '${oldName}' is now '${newName}'. Will be removed in v0.3.0.`,
    deprecated: oldName,
    replacement: newName,
  };
  pending = warning;
}

/** Pull and clear the pending warning (or null if none). */
export function consumePendingDeprecationWarning(): DeprecationWarning | null {
  const w = pending;
  pending = null;
  return w;
}
```

- [ ] **Step 4: Wire into `outputJson` (success path)**

Open `src/shared/result.ts`. Modify `outputJson`. To avoid the circular import (`shared/result.ts` → `cli/deprecation.ts` → ...), **move `deprecation.ts` into `src/shared/`**:

```bash
git mv src/cli/deprecation.ts src/shared/deprecation.ts
git mv src/cli/deprecation.test.ts src/shared/deprecation.test.ts
```

Update the test file's import to use `./deprecation.js` (it's now a sibling of `result.ts`). Update any other reference once the helper is consumed in Task C3.

Then in `src/shared/result.ts`:

```typescript
import { consumePendingDeprecationWarning } from "./deprecation.js";

export function ok<T extends Record<string, unknown>>(payload: T): T & { ok: true } {
  return {
    ok: true,
    ...payload,
  };
}

export function outputJson(value: unknown): void {
  const warning = consumePendingDeprecationWarning();
  if (warning !== null) {
    // SUCCESS path only: humans see the line on stderr; machines see the
    // `warning` field in the JSON. (The failure path is handled by the CLI
    // catch block — see src/cli/index.ts — which splices the warning into
    // the error JSON without writing the human line, so stderr stays
    // single-document-parseable on failure.)
    process.stderr.write(`${warning.message}\n`);
    if (typeof value === "object" && value !== null) {
      const enriched = { ...(value as Record<string, unknown>), warning };
      process.stdout.write(`${JSON.stringify(enriched, null, 2)}\n`);
      return;
    }
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
```

- [ ] **Step 5: Also surface the warning in the CLI error path**

The success path of a deprecated command flows through `outputJson` → JSON gets the `warning` field and stderr gets the human line. **The error path needs a parallel consumer** — `src/cli/index.ts:53–58` catches the thrown error and prints `errorToJson(error)` directly. Without this fix, a `list --json` run that fails (e.g. because the daemon is down) would emit the JSON error to stderr without the `warning` field — and the pending warning would leak across the process boundary. The fix splices `warning` into the error JSON and clears the pending state, so the contract holds: stderr is exactly one JSON document on failure, containing the warning.

Open `src/cli/index.ts`. The current catch block:

```typescript
try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorToJson(error), null, 2)}\n`);
  process.exitCode = error instanceof ShuttleError ? error.exitCode : 1;
}
```

Replace with:

```typescript
import { consumePendingDeprecationWarning } from "../shared/deprecation.js";

// ... later, in the catch:
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

This way the contract is consistent on the JSON surface: deprecated commands always surface the `warning` field in JSON output, whether they succeed (`outputJson` splices it into stdout) or fail (the CLI's catch block splices it into stderr). The human stderr line fires ONLY on success — the failure path keeps stderr as a single parseable JSON document.

- [ ] **Step 6: Add the error-path test**

Append to `src/shared/deprecation.test.ts`:

```typescript
test("a deprecation warning set but never consumed by outputJson is cleared by error-path consume", () => {
  // Simulates a deprecated action that throws before reaching outputJson.
  // The CLI error handler must consume the pending warning so it doesn't
  // leak across CLI invocations (in-process tests can reveal this leak).
  consumePendingDeprecationWarning(); // start clean
  withPendingDeprecationWarning("list", "secrets list");
  // (No outputJson call — simulate the throw.)
  // The CLI error handler would now consume:
  const w = consumePendingDeprecationWarning();
  assert.ok(w !== null);
  assert.equal(w.deprecated, "list");
  // And a second consume returns null (no leak):
  assert.equal(consumePendingDeprecationWarning(), null);
});
```

- [ ] **Step 7: Run tests — expect PASS**

```bash
npm run build && node --test "dist/shared/deprecation.test.js"
```

- [ ] **Step 8: Commit**

```bash
git add src/shared/deprecation.ts src/shared/deprecation.test.ts src/shared/result.ts src/cli/index.ts
git commit -m "feat(cli): deprecation helper — stderr + JSON warning (success and error paths)"
```

---

### Task C2: `internal` command group + move power-user commands

**Files:**
- Create: `src/cli/commands/internal.ts`
- Modify: `src/cli/index.ts`
- Delete: `src/cli/commands/use-as-stdin.ts`

The `internal` group registers the following as subcommands (each just re-exports the existing Commander command):
- `compare` (from `compare.ts`) — power-user verification, agents rarely need it
- `blind` (from `blind.ts`) — low-level CDP blind-mode control
- `capture` (from `capture.ts`) — V0 path, replaced by `reveal-capture`
- `inject` (from `inject.ts`) — V0 path, replaced by `inject-submit` (and Plan 3's new top-level `inject` will use the freed name)

**`daemon`, `unlock`, and `migrate` all stay at top level** — Plan 1's registry hints reference all three as recovery commands:
- `daemon_not_running` / `daemon_invalid_response` / `daemon_start_timeout` → `secret-shuttle daemon start` / `daemon status`
- `vault_locked` → `secret-shuttle unlock`
- `legacy_key_present` → `secret-shuttle migrate secure-vault`

And `status.next_action` (Task B1) returns the same literal strings. Relocating any of these under `internal` would break the hints AND the status state machine simultaneously. Keep them public.

Plus the four renamed-into-secrets commands stay as deprecated shims AT TOP LEVEL (so old scripts keep working for one release). The internal group does NOT shadow them.

- [ ] **Step 1: Create `src/cli/commands/internal.ts`**

```typescript
import { Command } from "commander";
import { compareCommand } from "./compare.js";
import { blindCommand } from "./blind.js";
import { captureCommand } from "./capture.js";
import { injectCommand } from "./inject.js";

export function internalCommand(): Command {
  const cmd = new Command("internal")
    .description("Power-user and deprecated commands. Most agents should not need these.");

  cmd.addCommand(compareCommand());
  cmd.addCommand(blindCommand());
  cmd.addCommand(captureCommand());
  cmd.addCommand(injectCommand());

  return cmd;
}
```

- [ ] **Step 2: Register in `src/cli/index.ts` as hidden**

Add the import and registration. Commander 12.x supports `{ hidden: true }` via the addCommand options or the `.command()` builder; check the Commander version in package.json (`12.x` per the import).

```typescript
import { internalCommand } from "./commands/internal.js";

// after other addCommand calls:
const internal = internalCommand();
program.addCommand(internal, { hidden: true });
```

Confirm `hidden: true` is the right option name for the Commander version in use. If not supported, fall back to:

```typescript
const internal = internalCommand();
(internal as unknown as { _hidden?: boolean })._hidden = true;
program.addCommand(internal);
```

(That's a documented Commander escape hatch.)

- [ ] **Step 3: Remove `use-as-stdin` registration**

In `src/cli/index.ts`, remove the line `program.addCommand(useAsStdinCommand());` and the corresponding import.

- [ ] **Step 4: Delete `src/cli/commands/use-as-stdin.ts`**

```bash
git rm src/cli/commands/use-as-stdin.ts
```

If a test file exists (`use-as-stdin.test.ts`), remove it too.

- [ ] **Step 5: Verify `internal --help` lists exactly four subcommands**

```bash
npm run build && node dist/cli/index.js internal --help 2>&1 | grep -E "compare|blind|capture|inject"
```

Expected: all four names appear. (And `unlock` / `migrate` do NOT appear — they're top-level.)

- [ ] **Step 6: Verify top-level `--help` shows `unlock`, `migrate`, `daemon` but NOT `internal`**

```bash
node dist/cli/index.js --help > /tmp/top-help.txt 2>&1
grep -q "^\s*unlock\b" /tmp/top-help.txt && echo "unlock: visible ✓" || echo "unlock: MISSING ✗"
grep -q "^\s*migrate\b" /tmp/top-help.txt && echo "migrate: visible ✓" || echo "migrate: MISSING ✗"
grep -q "^\s*daemon\b" /tmp/top-help.txt && echo "daemon: visible ✓" || echo "daemon: MISSING ✗"
grep -q "^\s*internal\b" /tmp/top-help.txt && echo "internal: VISIBLE ✗ (should be hidden)" || echo "internal: hidden ✓"
```

Expected: unlock / migrate / daemon visible; internal hidden.

- [ ] **Step 7: Smoke test that internal commands work AND that recovery-hint commands still resolve at top level**

```bash
# Top-level recovery commands (must work — status.next_action emits these strings):
node dist/cli/index.js unlock --help
node dist/cli/index.js migrate --help
node dist/cli/index.js daemon --help

# Internal power-user commands:
node dist/cli/index.js internal compare --help
node dist/cli/index.js internal blind --help
```

All should print help text without "unknown command" errors.

- [ ] **Step 8: Run full test suite**

```bash
npm test
```

Expected: PASS. The internal-group registration is additive; existing tests that call commands via the top-level Commander program (`program.parseAsync(["unlock", ...])`) continue to work because the top-level registrations are unchanged in this task (deprecation shims land in Task C3).

- [ ] **Step 9: Commit**

```bash
git add src/cli/commands/internal.ts src/cli/index.ts
git rm src/cli/commands/use-as-stdin.ts
git commit -m "feat(cli): internal command group (hidden); migrate use-as-stdin to deletion"
```

---

### Task C3: Deprecation shims on old top-level commands

**Files:**
- Modify: `src/cli/commands/list.ts`
- Modify: `src/cli/commands/inspect.ts`
- Modify: `src/cli/commands/generate.ts`
- Modify: `src/cli/commands/doctor.ts`

Each becomes a thin wrapper that calls `withPendingDeprecationWarning(oldName, newName)` before delegating to its replacement's action. The top-level command keeps the same flags + behavior; the only change is the warning emission.

Pattern (for `list.ts`):

```typescript
import { Command } from "commander";
import { secretsListCommand } from "./secrets/list.js";
import { withPendingDeprecationWarning } from "../../shared/deprecation.js";

export function listCommand(): Command {
  const wrapped = secretsListCommand();
  // Clone the wrapped command's options/help into a top-level command
  // with the same surface, but action wraps in a deprecation warning.
  const cmd = new Command("list")
    .description("(deprecated) Use 'secret-shuttle secrets list' instead.")
    .option("--env <environment>")
    .option("--source <source>")
    .action(async (options) => {
      withPendingDeprecationWarning("list", "secrets list");
      // Delegate to the same action body by re-using secretsListCommand's logic.
      // The simplest path: call the same daemonRequest directly here.
      const { daemonRequest } = await import("../../client/daemon-client.js");
      const { ok, outputJson } = await import("../../shared/result.js");
      const body: Record<string, string> = {};
      if (options.env !== undefined) body.environment = options.env;
      if (options.source !== undefined) body.source = options.source;
      const r = await daemonRequest("POST", "/v1/secrets/list", body);
      outputJson(ok(r as Record<string, unknown>));
    });
  return cmd;
}
```

Repeat the same shim pattern for `inspect.ts` → `secrets get-ref`, `generate.ts` → `secrets set`, `doctor.ts` → `status`.

**Note:** the shims keep the existing flag-parsing semantics. The action delegates by reusing the same daemonRequest shape. Don't try to share the action function between the old and new commands directly — Commander binds the action to a specific Command instance and that gets messy.

- [ ] **Step 1: Add failing test for deprecation warning emission**

Create `src/cli/commands/list.test.ts` (or extend if exists):

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumePendingDeprecationWarning } from "../../shared/deprecation.js";

test("listCommand action triggers a deprecation warning before delegating", async () => {
  // We don't actually want to call the daemon here. The test only checks
  // that invoking the action's first step (the warning) flips the
  // deprecation flag.
  //
  // Trick: dynamically construct an action-trigger context.
  const { listCommand } = await import("./list.js");
  const cmd = listCommand();
  // Find the action by reading the Commander internal action ref; we
  // can't call it directly without the daemon, so we settle for a
  // structural check: the action description starts with "(deprecated)".
  assert.match(cmd.description(), /deprecated/i);
});
```

(A stronger e2e test would spawn the CLI as a subprocess and inspect stderr. That's covered in F1. This task's test is structural.)

- [ ] **Step 2: Run — expect FAIL** (description not updated yet)

- [ ] **Step 3: Implement the four shims**

For each of `list.ts`, `inspect.ts`, `generate.ts`, `doctor.ts`, follow the pattern above. Specifically:

**`src/cli/commands/list.ts`:** see pattern above.

**`src/cli/commands/inspect.ts`:**

```typescript
import { Command } from "commander";
import { withPendingDeprecationWarning } from "../../shared/deprecation.js";

export function inspectCommand(): Command {
  return new Command("inspect")
    .description("(deprecated) Use 'secret-shuttle secrets get-ref' instead.")
    .argument("<ref>")
    .action(async (ref: string) => {
      withPendingDeprecationWarning("inspect", "secrets get-ref");
      const { daemonRequest } = await import("../../client/daemon-client.js");
      const { ok, outputJson } = await import("../../shared/result.js");
      const { normalizeRef } = await import("./helpers.js");
      const r = await daemonRequest("POST", "/v1/secrets/inspect", { ref: normalizeRef(ref) });
      outputJson(ok(r as Record<string, unknown>));
    });
}
```

**`src/cli/commands/generate.ts`:** keep existing implementation, add deprecation shim at top of action:

```typescript
// At the start of the existing action body:
withPendingDeprecationWarning("generate", "secrets set");
```

Update description: `"(deprecated) Use 'secret-shuttle secrets set' instead."`.

**`src/cli/commands/doctor.ts`:** keep existing implementation, add deprecation at top of action. Keep `formatDoctorText` and `DoctorReport` exports — `statusCommand` consumes them.

Update description: `"(deprecated) Use 'secret-shuttle status' instead."`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm run build && node --test "dist/cli/commands/list.test.js"
```

- [ ] **Step 5: Smoke test — contract differs by outcome**

Two scenarios:

**Scenario A (success path).** Daemon running; vault unlocked; `list` returns successfully. Expected: stderr has the human deprecation line; stdout JSON contains a `warning` field.

```bash
# Assumes a working daemon + unlocked vault.
node dist/cli/index.js list --json 2>/tmp/stderr.log 1>/tmp/stdout.log
grep "\\[deprecated\\]" /tmp/stderr.log   # should match — human line on stderr
grep '"warning"' /tmp/stdout.log          # should match — JSON warning field
```

**Scenario B (failure path).** Daemon NOT running; `list` throws. Expected: stderr contains a SINGLE JSON document (the error with a `warning` field), no human line.

```bash
# Stop the daemon first so the call fails.
node dist/cli/index.js daemon stop 2>/dev/null || true
node dist/cli/index.js list --json 2>/tmp/stderr.log 1>/tmp/stdout.log
# stderr should be parseable as a single JSON document:
python3 -c "import json,sys; print(json.load(open('/tmp/stderr.log')))" \
  || { echo "stderr is NOT single-document JSON — fix the catch block in src/cli/index.ts"; exit 1; }
# The JSON should contain warning + error_code:
grep '"warning"' /tmp/stderr.log
grep '"error_code"' /tmp/stderr.log
```

The two tests together prove the contract: stderr-as-mixed-stream on success (humans see line; agents read JSON from stdout), stderr-as-single-JSON-document on failure (agents pipe stderr through `jq` and get everything in one shot).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/list.ts src/cli/commands/inspect.ts src/cli/commands/generate.ts src/cli/commands/doctor.ts src/cli/commands/list.test.ts
git commit -m "feat(cli): deprecation shims on list/inspect/generate/doctor delegating to new names"
```

---

## Part D — Help text overhaul

### Task D1: `secret-shuttle help [command]` progressive disclosure

**Files:**
- Create: `src/cli/commands/help.ts`
- Create: `src/cli/commands/help.test.ts`
- Modify: `src/cli/index.ts`

**Behavior:**
- `secret-shuttle help` (no args) prints a curated, grouped one-liner list of public commands — **not** Commander's default `--help` output (which is alphabetical and verbose).
- `secret-shuttle help <command>` prints that command's `--help` (equivalent to `secret-shuttle <command> --help`).

Per spec §5.8, the output target is ≤ 30 lines, scannable, grouped (Setup / Secrets / Process integration / Provider integration / Agent).

- [ ] **Step 1: Failing test**

Create `src/cli/commands/help.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { renderTopLevelHelp, helpCommand } from "./help.js";

test("renderTopLevelHelp output groups commands and stays under 30 lines", () => {
  const output = renderTopLevelHelp();
  const lines = output.split("\n");
  assert.ok(lines.length <= 32, `expected ≤32 lines, got ${lines.length}`); // 30 + small buffer
  // Spot-check the groups are present:
  assert.match(output, /Setup/);
  assert.match(output, /Secrets/);
  assert.match(output, /Provider integration/);
  assert.match(output, /Agent/);
  // Spot-check a few commands are listed:
  assert.match(output, /\binit\b/);
  assert.match(output, /\bstatus\b/);
  assert.match(output, /\bsecrets list\b/);
  // Public recovery commands MUST appear — registry hints + status.next_action
  // emit these as bare top-level commands, so the curated help has to surface
  // them too, or agents reading help will look for the wrong place.
  assert.match(output, /^\s*unlock\b/m);
  assert.match(output, /\bmigrate secure-vault\b/);
  assert.match(output, /\bdaemon start\|stop\|status\b/);
  // Internal namespace should NOT appear in curated help:
  assert.doesNotMatch(output, /\binternal\b/);
  // Deprecated names should NOT appear (they're shims, not the curated path):
  assert.doesNotMatch(output, /^\s{2}list\b/m);    // old name; curated says "secrets list"
  assert.doesNotMatch(output, /^\s{2}inspect\b/m); // old name; curated says "secrets get-ref"
  assert.doesNotMatch(output, /^\s{2}generate\b/m); // old name; curated says "secrets set"
  assert.doesNotMatch(output, /^\s{2}doctor\b/m);   // old name; curated says "status"
  // Future-tense commands must NOT appear:
  assert.doesNotMatch(output, /\brestart\b/); // daemon restart doesn't exist
});

test("helpCommand resolves and prints help for a top-level command", async () => {
  // Build a minimal program that mirrors how src/cli/index.ts wires things.
  const program = new Command("secret-shuttle");
  const fake = new Command("fake").description("a fake command for testing").option("--flag");
  program.addCommand(fake);
  program.addCommand(helpCommand());

  // Capture stdout.
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["help", "fake"], { from: "user" });
  } finally {
    process.stdout.write = origWrite;
  }
  const out = chunks.join("");
  // Commander's helpInformation() output contains the command's description.
  assert.match(out, /a fake command for testing/);
  assert.match(out, /--flag/);
});

test("helpCommand resolves a space-separated path (e.g. 'secrets list')", async () => {
  const program = new Command("secret-shuttle");
  const secrets = new Command("secrets").description("secrets group");
  secrets.addCommand(new Command("list").description("list secrets"));
  program.addCommand(secrets);
  program.addCommand(helpCommand());

  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["help", "secrets", "list"], { from: "user" });
  } finally {
    process.stdout.write = origWrite;
  }
  const out = chunks.join("");
  assert.match(out, /list secrets/);
});

test("helpCommand reports unknown command path on stderr with exit code 1", async () => {
  const program = new Command("secret-shuttle");
  program.addCommand(helpCommand());

  const stderrChunks: string[] = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  const origExit = process.exitCode;
  try {
    await program.parseAsync(["help", "nope"], { from: "user" });
  } finally {
    process.stderr.write = origStderr;
  }
  const err = stderrChunks.join("");
  assert.match(err, /unknown command 'nope'/);
  assert.equal(process.exitCode, 1);
  process.exitCode = origExit;
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Create `src/cli/commands/help.ts`:

```typescript
import { Command } from "commander";

/**
 * Curated, grouped one-line help. Stays under 30 lines per spec §5.8.
 * Exported as a pure function for unit testing.
 *
 * Only lists commands that actually exist today — no future-tense entries.
 * Re-audit this every time a public command is added or removed.
 */
export function renderTopLevelHelp(): string {
  return [
    "secret-shuttle — Let AI agents use secrets without seeing them.",
    "",
    "Setup & recovery:",
    "  init                        Interactive first-run setup",
    "  status                      Daemon, vault, and browser health",
    "  daemon start|stop|status    Daemon lifecycle",
    "  unlock                      Unlock the vault (passphrase via browser window)",
    "  migrate secure-vault        Migrate a legacy vault to the envelope format",
    "",
    "Secrets:",
    "  secrets list                List stored refs (metadata only)",
    "  secrets get-ref <ref>       Show metadata for a ref",
    "  secrets set <name> ...      Store a new secret",
    "  secrets delete <ref>        Soft-delete a secret",
    "  secrets rotate <ref>        Rotate a secret",
    "",
    "Provider integration:",
    "  template list / template run <id>            Vetted CLI integrations",
    "  browser mark / reveal-capture / inject-submit   Browser-mediated flows",
    "",
    "Agent:",
    "  agent install claude|codex|cursor|copilot    Install operating manual",
    "  agent print-skill-url                        Print remote skill URL",
    "  help [command]                               This page, or per-command help",
    "",
    "For per-command help: secret-shuttle <command> --help",
    "",
  ].join("\n");
}

/**
 * Resolve a Commander command from the registered program tree by space-
 * separated path (e.g. "secrets list" → program → 'secrets' → 'list').
 * Returns null if any segment isn't a registered subcommand.
 */
function resolveCommandPath(root: Command, path: string): Command | null {
  const segments = path.split(/\s+/).filter((s) => s.length > 0);
  let cur: Command = root;
  for (const seg of segments) {
    const next = cur.commands.find((c) => c.name() === seg);
    if (next === undefined) return null;
    cur = next;
  }
  return cur === root ? null : cur;
}

export function helpCommand(): Command {
  return new Command("help")
    .description("Show curated command list (or per-command help with: help <command>).")
    .argument("[command...]", "Command name (space-separated, e.g. 'secrets list') to show detailed help for.")
    .action(function (this: Command, commandParts: string[] | undefined) {
      if (commandParts === undefined || commandParts.length === 0) {
        process.stdout.write(renderTopLevelHelp());
        return;
      }
      // 'this' is the help Command instance; its parent is the root program.
      const root = (this as unknown as { parent: Command | null }).parent;
      if (root === null) {
        process.stderr.write("help: cannot resolve root program\n");
        process.exitCode = 1;
        return;
      }
      const path = commandParts.join(" ");
      const target = resolveCommandPath(root, path);
      if (target === null) {
        process.stderr.write(`help: unknown command '${path}'\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(target.helpInformation());
    });
}
```

- [ ] **Step 4: Register in `src/cli/index.ts`**

```typescript
import { helpCommand } from "./commands/help.js";
// ...
program.addCommand(helpCommand());
```

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Smoke**

```bash
node dist/cli/index.js help
node dist/cli/index.js help status
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/help.ts src/cli/commands/help.test.ts src/cli/index.ts
git commit -m "feat(cli): help [command] — curated progressive-disclosure entry under 30 lines"
```

---

### Task D2: Per-command `--help` audit — add examples in epilog

**Files:** Multiple — every public command that doesn't already have `addHelpText("after", ...)` in its definition.

Commands that need an epilog (one round of audit + addition):
- `agent` — install/print-skill-url
- `browser` — start/mark
- `daemon` — start/stop/status
- `init`
- `inject-submit`
- `reveal-capture`
- `template` — list/run

Commands that already have epilogs (after Tasks A2–A6, B1): `secrets list`, `secrets get-ref`, `secrets set`, `secrets delete`, `secrets rotate`, `status`.

Commands moved to `internal` — DON'T add epilogs (low-priority; power-user only).

For each command file:
1. Read it.
2. Identify each `.option()` / `.argument()` to inform examples.
3. Add a `.addHelpText("after", \`...\`)` block following the pattern:

```typescript
.addHelpText("after", `
Examples:
  # <Short description of the first example>:
  secret-shuttle <command> [<args>]

  # <Short description of the second example>:
  secret-shuttle <command> [<args>]
`);
```

- [ ] **Step 1: Audit each top-level command and add epilog where missing**

Open each file and add the epilog. The exact text depends on the command's options. Use this template per file:

**For `src/cli/commands/agent.ts`:**

```
Examples:
  # Install the skill into a Claude Code project:
  secret-shuttle agent install claude

  # Print the canonical raw skill URL (paste into any agent):
  secret-shuttle agent print-skill-url
```

**For `src/cli/commands/browser.ts`:** add epilog with start + mark focused/pick examples (look at the existing code to get the option shapes).

**For `src/cli/commands/daemon.ts`:** add epilog with start / stop / status examples.

**For `src/cli/commands/init.ts`:** add epilog noting it's a thin status wrapper (current) and that Plan 5a rewrites this. Single example: `secret-shuttle init`.

**For `src/cli/commands/inject-submit.ts`:** add epilog with one complete example.

**For `src/cli/commands/reveal-capture.ts`:** same.

**For `src/cli/commands/template.ts`:** add epilog with `template list` + `template run vercel-env-add ...`.

- [ ] **Step 2: Run all CLI tests + a smoke test**

```bash
npm test
for cmd in agent browser daemon init inject-submit reveal-capture template; do
  echo "=== $cmd ===" && node dist/cli/index.js $cmd --help 2>&1 | tail -5
done
```

Each should print an "Examples:" block at the bottom.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/agent.ts src/cli/commands/browser.ts src/cli/commands/daemon.ts \
  src/cli/commands/init.ts src/cli/commands/inject-submit.ts src/cli/commands/reveal-capture.ts \
  src/cli/commands/template.ts
git commit -m "feat(cli): --help epilog with copy-pasteable examples on every public command"
```

---

## Part E — Pre-existing HTTP error paths fix

### Task E1: Route server.ts pre-handler error paths through errorToJson

**Files:**
- Modify: `src/daemon/server.ts:88-92, 100-103, 109-112`
- Modify: `src/daemon/server.test.ts` (if exists; else create with smoke tests for the three paths)

**Today:** the three pre-handler short-circuits emit `{ ok: false, error: { code: "bad_host" } }` — missing `message` (always), missing the new flat `error_code`/`message`/`hint`/`exit_code` fields. They bypass `errorToJson`.

**After:** each path constructs a `ShuttleError` with the right code + message, then routes through `writeError` (which already uses `errorToJson`).

- [ ] **Step 1: Add the codes to the registry if missing**

Check `src/shared/error-codes.ts` for `bad_host`, `unauthorized`, `not_found`. If absent, add to the registry with appropriate exit codes:

- `bad_host` → `EXIT_CODE_PERMISSION` (host header rejected)
- `unauthorized` → `EXIT_CODE_PERMISSION`
- `not_found` → `EXIT_CODE_NOT_FOUND`

(Reuse `EXIT_CODE_NOT_FOUND` for the not_found route case — semantically matches.)

Each registry entry: `{ exitCode: <code>, hint: () => null }` since the agent's action on bad host / unauthorized is to fix the request itself, not run another command.

- [ ] **Step 2: Modify `src/daemon/server.ts`**

Replace lines 87-92 (bad_host):

OLD:
```typescript
if (!ALLOWED_HOST_PREFIXES.some((p) => host.startsWith(p))) {
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: { code: "bad_host" } }));
  return;
}
```

NEW:
```typescript
if (!ALLOWED_HOST_PREFIXES.some((p) => host.startsWith(p))) {
  this.writeError(res, new ShuttleError("bad_host", `Rejected host: ${host}`));
  return;
}
```

Replace lines 99-103 (unauthorized):

OLD:
```typescript
if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: { code: "unauthorized" } }));
  return;
}
```

NEW:
```typescript
if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
  // writeError sets status 400 by default for ShuttleError; override to 401 for auth failure.
  const err = new ShuttleError("unauthorized", "Invalid or missing bearer token.");
  const payload = errorToJson(err);
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
  return;
}
```

Replace lines 108-112 (not_found):

OLD:
```typescript
if (handler === undefined) {
  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: { code: "not_found" } }));
  return;
}
```

NEW:
```typescript
if (handler === undefined) {
  // writeError defaults to 400; override to 404 to preserve HTTP semantics.
  const err = new ShuttleError("not_found", `No route for ${req.method} ${urlPath}`);
  const payload = errorToJson(err);
  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
  return;
}
```

The remaining unhandled-exception path inside `writeError` (line 122-128) already uses `errorToJson` correctly — unchanged.

- [ ] **Step 3: Add tests for each path**

If `src/daemon/server.test.ts` exists, append. Else create. Pattern:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonServer } from "./server.js";

test("bad host header → 400 with full error contract", async () => {
  const server = new DaemonServer({ token: "tok" });
  const { port } = await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Host: "evil.example.com", Authorization: "Bearer tok" },
    });
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.equal(j.error.code, "bad_host");
    assert.equal(j.error_code, "bad_host");
    assert.ok(typeof j.message === "string" && j.message.length > 0, "message should be non-empty");
    assert.equal(j.exit_code, 4); // EXIT_CODE_PERMISSION
  } finally {
    await server.close();
  }
});

test("missing bearer token → 401 with full error contract", async () => {
  const server = new DaemonServer({ token: "tok" });
  const { port } = await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(res.status, 401);
    const j = await res.json();
    assert.equal(j.error_code, "unauthorized");
    assert.equal(j.exit_code, 4);
  } finally {
    await server.close();
  }
});

test("unknown route → 404 with full error contract", async () => {
  const server = new DaemonServer({ token: "tok" });
  const { port } = await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/nope`, {
      headers: { Authorization: "Bearer tok" },
    });
    assert.equal(res.status, 404);
    const j = await res.json();
    assert.equal(j.error_code, "not_found");
    assert.equal(j.exit_code, 3); // EXIT_CODE_NOT_FOUND
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/daemon/server.ts src/daemon/server.test.ts src/shared/error-codes.ts
git commit -m "fix(daemon): pre-handler error paths emit full structured-error contract"
```

---

## Part F — Docs + verification + CHANGELOG

### Task F1: Update `docs/cli-reference.md` for Plan 2 surface changes

**Files:**
- Modify: `docs/cli-reference.md`

A full rewrite of the CLI reference is Plan 5b's job. **Plan 2 ships the minimum to keep the shipped docs honest:** remove the `use-as-stdin` section (since the command is deleted in Task C2), and add a top-of-file banner pointing readers at `secret-shuttle help` + per-command `--help` for current truth.

- [ ] **Step 1: Remove the use-as-stdin section**

`docs/cli-reference.md` has a section `## secret-shuttle use-as-stdin` (verified at line 161). Delete that section header and its body (everything until the next `##` header). Also remove any inline mention of `use-as-stdin` elsewhere in the file:

```bash
grep -n "use-as-stdin\|use_as_stdin" docs/cli-reference.md
```

For each hit, either remove the line (if it's a reference to the command itself) or — for `--allow-action use_as_stdin` style mentions — leave a note that `use_as_stdin` remains as a vault-record action value for historical refs but no CLI command emits it.

- [ ] **Step 2: Add a top-of-file banner**

Insert this banner immediately after the file's existing top heading:

```markdown
> **Note (v0.2.0+):** the CLI surface was reshaped in v0.2.0 — `secrets` is the new namespace for vault primitives (`secrets list/get-ref/set/delete/rotate`) and `status` replaces `doctor`. Recovery commands (`daemon start/status/stop`, `unlock`, `migrate secure-vault`) stay at top level — they're what the structured-error `hint` and `status.next_action` fields point at. Power-user paths (`compare`, `blind`, `capture`, V0 `inject`) live under `secret-shuttle internal *`. Old names (`list`, `inspect`, `generate`, `doctor`) still work but print a deprecation warning and will be removed in v0.3.0. Run `secret-shuttle help` for the curated public-command index or `secret-shuttle <command> --help` for per-command details — those are the current source of truth while this reference is being updated.
```

This banner is honest about partial coverage and points readers at the in-CLI help (which IS up-to-date thanks to Tasks D1/D2).

- [ ] **Step 3: Run a spot check**

```bash
grep -c "use-as-stdin" docs/cli-reference.md
```

Expected: 0 (or only inside the `--allow-action use_as_stdin` historical note, if you kept that). Either way, no top-level section advertising the deleted command.

- [ ] **Step 4: Commit**

```bash
git add docs/cli-reference.md
git commit -m "docs(cli-reference): remove use-as-stdin section; add v0.2.0 surface-changes banner"
```

---

### Task F2: Full test suite verification

(Working-tree hygiene was enforced as a hard gate in the Pre-execution checklist before Task A1; not re-run here.)

- [ ] **Step 1: Run `npm test`**

Expect ALL pass. If anything fails:
- If a test in the renamed-but-still-shimmed commands (`list.test.ts`, etc.) fails because of the deprecation warning leaking into JSON output, update the assertion to match the new shape (the `warning` field is additive).
- If `secrets.test.ts` fails, debug.

- [ ] **Step 2: Run `npm run typecheck`**

Expect PASS.

- [ ] **Step 3: Run `npm run check-pack`**

Expect PASS.

- [ ] **Step 4: Manual smoke tests**

Run each:

```bash
node dist/cli/index.js help
node dist/cli/index.js status --json   # daemon may not be running; that's fine, just check shape
node dist/cli/index.js secrets list --json
# Success scenario: deprecation human line on stderr + warning field in stdout JSON.
node dist/cli/index.js list --json
# Failure scenario: daemon stopped → stderr is a SINGLE JSON document with warning field.
node dist/cli/index.js daemon stop 2>/dev/null || true
node dist/cli/index.js list --json 2>/tmp/stderr.log 1>/dev/null
python3 -c "import json; print(json.load(open('/tmp/stderr.log')).get('warning'))"

node dist/cli/index.js internal --help      # should list 4 power-user commands
node dist/cli/index.js --help              # should NOT show 'internal' in command list
node dist/cli/index.js --help              # SHOULD show unlock, migrate, daemon at top level
```

Expected:
- `help` prints the curated grouped list (init / status / daemon / unlock / migrate visible under Setup; secrets group; provider integration; agent commands).
- `status --json` prints `{ ok: true, ready, next_action, report }`.
- `secrets list` succeeds (or fails with the daemon-not-running structured error).
- `list --json` on success: `[deprecated] 'list' is now 'secrets list'. ...` on stderr + `warning` field in stdout JSON.
- `list --json` on failure: stderr is a single parseable JSON document with `error_code` AND `warning` fields; no separate stderr human line.
- `internal --help` shows exactly **four** commands: `compare`, `blind`, `capture`, `inject`.
- Top-level `--help` doesn't include `internal` but does include `unlock`, `migrate`, `daemon`.

- [ ] **Step 5: No-commit step (verification only)**

If all the above are green, proceed to F3.

---

### Task F3: CHANGELOG update

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append a `## Unreleased` entry** (or extend the existing one from Plan 1)

```markdown
### Added — Plan 2 (CLI surface)
- `secrets` command group (`list` / `get-ref` / `set` / `delete` / `rotate`). `set` is a rename of `generate`; `--kind paste` is reserved and rejected with a deferral hint (lands in Plan 4). `delete` is a soft-delete with audit trail. `rotate` generates a new ref and marks the old one as `rotating`; the destination re-push plan is empty in this release (audit-log destination synthesis is a follow-up).
- `status` command (rename of `doctor`) emits `ready: boolean` + `next_action: string | null` at the top level so agents can drive a state machine without inspecting nested fields. Existing `doctor` text formatting is preserved inside the `report` field.
- `internal` command group (hidden from default `--help`) absorbs the power-user / deprecated paths: `compare`, `blind`, `capture`, and the V0 `inject`. **`daemon`, `unlock`, and `migrate` stay top-level** — they're the recovery commands surfaced by structured-error hints and `status.next_action`.
- `secret-shuttle help` curated progressive-disclosure entry — grouped one-line index of public commands, ≤30 lines.
- Per-command `--help` epilogs with copy-pasteable examples for every public command.

### Changed
- Old top-level commands `list`, `inspect`, `generate`, `doctor` remain available as deprecated shims that delegate to their `secrets *` / `status` replacement. JSON output (stdout on success, stderr on failure) always carries a `warning: { message, deprecated, replacement }` field. On success, stderr additionally gets a human-readable `[deprecated] ...` line; on failure, stderr is a single parseable JSON document — no separate human line. Scheduled for removal in v0.3.0.
- `use-as-stdin` command removed (deprecated in 0.1.x; replaced by `template run`).
- `src/daemon/server.ts` pre-handler error paths (bad_host, unauthorized, not_found) now emit the full §5.6 structured-error contract instead of the partial legacy shape.

### Security
- N/A for Plan 2 (no security-relevant code introduced; the server.ts pre-handler change is a contract uniformity fix, not a vulnerability).
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Plan 2 — secrets group + status + internal + help + server error contract"
```

---

## Self-Review

**1. Spec coverage (revised post-review)**

| Spec §11 deliverable | Task |
|---|---|
| `secret-shuttle status` (rename + shape extension) | B1 |
| `secret-shuttle secrets list` (incl. `--include-deleted` per soft-delete invariant) | A1 + A2 + A5 |
| `secret-shuttle secrets get-ref` (deleted refs → secret_not_found) | A1 + A3 + A5 |
| `secret-shuttle secrets set` (paste mode rejected; not exposing internal plan numbers) | A1 + A4 |
| `secret-shuttle secrets delete` (soft delete + invariant + public Vault API + approval action + UI copy) | A5 |
| `secret-shuttle secrets rotate` (minimal scope; uses public `getSecret`; new ApprovalBinding action) | A6 |
| `secret-shuttle help [command]` (real impl via Commander helpInformation walk; curated list lists only real commands) | D1 |
| `secret-shuttle internal *` namespace + commands moved | C2 |
| `daemon` stays public (NOT moved into internal — Plan 1 hints depend on it) | C2 (explicit non-action) |
| `POST /v1/secrets/delete` | A5 |
| `POST /v1/secrets/rotate` | A6 |
| Approval binding union extended (`secrets_delete`, `secrets_rotate`) + UI copy | A5 step 2b + 2c |
| Every command's `--help` has example in epilog | A2-A6, B1, D2 |
| Deprecation warning surfaces in BOTH success path (`outputJson`) AND error path (CLI catch block) | C1 (steps 4-6) |
| Pre-existing HTTP error paths fix (carry-over from Plan 1 A4 review) | E1 |
| docs/cli-reference.md: remove use-as-stdin section + v0.2.0 banner | F1 (new) |
| CHANGELOG | F3 (renumbered) |
| `secret-shuttle init` rewrite | NOT in Plan 2 — Plan 5a |
| `POST /v1/keychain/unlock` | NOT in Plan 2 — Plan 5a |
| `POST /v1/run/resolve` | NOT in Plan 2 — Plan 3 |
| `POST /v1/inject/render` | NOT in Plan 2 — Plan 3 |
| `POST /v1/approvals/session` | NOT in Plan 2 — Plan 4 |
| Single-window tab reuse | NOT in Plan 2 — Plan 4 (§5.10) |
| `secrets set --kind paste` UI flow | NOT in Plan 2 — Plan 4 (overlaps with tab reuse) |
| Full `docs/cli-reference.md` rewrite | NOT in Plan 2 — Plan 5b |

**Gaps:** none for Plan 2's scope. Items deferred to Plans 3/4/5 are correctly flagged.

**2. Placeholder scan**

- No "TBD", "TODO", "implement later" in the plan.
- Every code block contains complete code.
- Every command shows expected output.
- No user-facing references to internal plan numbers in CLI copy.

**3. Type consistency**

- `secretsCommand` / `secretsListCommand` / `secretsGetRefCommand` / `secretsSetCommand` / `secretsDeleteCommand` / `secretsRotateCommand` named consistently across the dispatcher (A1) and the individual files (A2–A6).
- `statusCommand`, `internalCommand`, `helpCommand` named consistently.
- `withPendingDeprecationWarning` / `consumePendingDeprecationWarning` named consistently between `src/shared/deprecation.ts` (C1 after the move out of `src/cli/`), `src/shared/result.ts` (C1 step 4), `src/cli/index.ts` (C1 step 5), and the deprecation shims (C3).
- `softDelete(ref)`, `markRotating(ref)`, the existing `list({ environment, source, includeDeleted })`, the existing `inspect(ref)`, and the updated `getSecret(ref)` on Vault are referenced consistently between vault.ts changes (A5, A6) and the daemon endpoints (A5, A6). No new method returning `SecretRecord[]` is introduced — that would leak `value` over the wire.
- Route registrars all take `daemonPortRef: () => number` as the third arg and call `daemonPortRef()` when building approval bindings — matches the existing convention in `src/daemon/api/routes/secrets.ts`.
- `unlock`, `migrate`, and `daemon` are NOT in the `internal` group — they stay top-level because registry hints and `status.next_action` emit their bare top-level names as recovery commands.
- `ApprovalBinding.action` union extended with `"secrets_delete"` and `"secrets_rotate"` in A5 step 2b; both endpoints reference exactly those literals.
- `DoctorReport` type from doctor.ts (preserved) is imported by status.ts (B1) — consistent.

**4. Scope check**

Plan 2 is one coherent CLI-surface migration. Two large units (secrets group + status) plus structural housekeeping (internal namespace, deprecation, help, server.ts fix, cli-reference banner). 16 tasks (A1–A6, B1, C1–C3, D1–D2, E1, F1–F3), each bite-sized. Estimated execution time: 5–6 hours for a fresh subagent doing one task at a time with TDD + verification.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-phase1-plan2-secrets-status-internal.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance, then code quality) per task, review between tasks. Same pattern as Plan 1.

**2. Inline Execution** — Batch tasks in this session using `superpowers:executing-plans`.

Which approach?
