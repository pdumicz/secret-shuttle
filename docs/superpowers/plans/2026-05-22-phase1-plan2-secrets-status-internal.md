# Phase 1 — Plan 2: secrets group + status + internal namespace + help

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the user-facing CLI surface to match category conventions (op / doppler / infisical) — introduce the `secrets` command group (5 subcommands), rename `doctor` → `status`, move power-user commands under `internal`, add a deprecation layer that keeps old names working with stderr + JSON warnings, ship the new `secret-shuttle help` progressive-disclosure entry, and audit every command's `--help` to include a copy-pasteable example.

**Architecture:** Mostly additive + renames. The new `secrets` group wraps existing list/inspect/generate semantics under a Commander subcommand tree; two genuinely new commands (`delete`, `rotate`) each get a thin daemon endpoint that reuses existing vault and approval infrastructure. `status` reuses doctor's report-gathering logic and adds a `ready` boolean + `next_action` field. `internal` is a hidden Commander command group that absorbs `unlock`, `compare`, `migrate`, `blind`, `capture`, `inject` (V0), and `daemon` subcommands that agents shouldn't see in default help. A small `deprecated(oldName, newName, action)` wrapper handles the dual-channel warning (stderr line + JSON `warning` field). Plus one cleanup: the three pre-handler error paths in `src/daemon/server.ts` get routed through `errorToJson` so every HTTP response emits the §5.6 contract uniformly.

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

- **`secrets set --kind paste` mode** — §5.2 specifies a trusted browser-window paste flow. Requires new UI page + daemon endpoint + polling overlap with Plan 4's tab-reuse work. **Plan 2 ships `secrets set` as a rename of `generate` (random + capture); paste lands in Plan 4.** A `--kind paste` invocation will error with `unsupported_secret_kind` and a hint pointing at Plan 4 once that lands.
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
| `src/cli/index.ts` | Register `secretsCommand`, `statusCommand`, `internalCommand`, `helpCommand`. Remove direct top-level registration of `unlock`, `compare`, `migrate`, `blind`, `capture`, `inject` (V0), `useAsStdin`, and the old `list`/`inspect`/`generate`/`doctor` (they're available via deprecated shims and via `secrets`/`status`). |
| `src/cli/commands/list.ts` | Stays as a deprecated shim — wraps `secretsListCommand` behavior with `deprecated('list','secrets list')`. |
| `src/cli/commands/inspect.ts` | Deprecated shim → `secrets get-ref`. |
| `src/cli/commands/generate.ts` | Deprecated shim → `secrets set`. |
| `src/cli/commands/doctor.ts` | Deprecated shim → `status`. Internal report-gathering logic stays exported for `statusCommand` to consume. |
| `src/cli/commands/use-as-stdin.ts` | **DELETE** (already documented as removed; readme/SKILL no longer reference it). |
| `src/daemon/server.ts` | Fix three pre-handler error paths (lines 88-92, 100-103, 109-112) to route through `errorToJson` so they emit the §5.6 contract. |
| `src/daemon/api/router.ts` *(or wherever routes are registered)* | Register `/v1/secrets/delete` and `/v1/secrets/rotate`. |
| `src/vault/vault.ts` | Add `softDelete(ref)` method + `markRotating(ref)` method. (Soft delete = vault record gets `deleted_at: ISO`; subsequent reads filter unless `--include-deleted`.) |
| `src/vault/types.ts` | Add `deleted_at?: string` and `rotating?: boolean` to `SecretRecord`. |
| `CHANGELOG.md` | Append Plan 2 entries. |

**Files to delete:**

| Path | Reason |
|---|---|
| `src/cli/commands/use-as-stdin.ts` | Removed per README; replaced by `template run`. Plan 2 finalizes the deletion. |

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
    .option("--kind <kind>", "Generation kind: random_32_bytes | random_24_chars | ... | paste (Plan 4).", "random_32_bytes")
    .option("--allow-domain <domain>", "Domain allow-list for inject (repeatable).", collectRepeated, [])
    .option("--allow-action <action>", "Allowed action (repeatable).", collectRepeated, [])
    .option("--description <description>", "Free-form description (stored in metadata).")
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .option("--approval-id <id>", "Pre-issued approval id (skip the approval window).")
    .option("--no-wait", "Return approval_required without waiting.")
    .action(async (options) => {
      // Reject paste mode until Plan 4 lands the trusted-UI paste flow.
      if (options.kind === "paste") {
        throw new ShuttleError(
          "unsupported_secret_kind",
          "--kind paste is not yet implemented (planned for Plan 4). Use a random kind or capture from a provider page via reveal-capture.",
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
  5  Conflict (ref already exists; re-run with --force, or use 'secrets rotate' once Plan 2 ships rotate)
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

### Task A5: `secrets delete` (new — CLI + daemon endpoint)

**Files:**
- Create: `src/daemon/api/routes/secrets-delete.ts`
- Create: `src/daemon/api/routes/secrets-delete.test.ts`
- Modify: `src/cli/commands/secrets/delete.ts` (replace placeholder)
- Modify: `src/cli/commands/secrets/secrets.test.ts`
- Modify: `src/vault/vault.ts` — add `softDelete(ref)` method
- Modify: `src/vault/types.ts` — add `deleted_at?: string` to `SecretRecord`
- Modify: `src/daemon/api/router.ts` (or equivalent route registrar) — register `/v1/secrets/delete`

**Behavior:** Soft delete — set `deleted_at` on the vault record, keep audit trail. `list` filters deleted entries by default; `--include-deleted` shows them. Production refs require approval.

- [ ] **Step 1: Add `deleted_at?: string` to `SecretRecord`**

Open `src/vault/types.ts`. Find the `SecretRecord` interface (or type). Add a new optional field:

```typescript
export interface SecretRecord {
  // ... existing fields
  deleted_at?: string; // ISO-8601 if soft-deleted; field absent otherwise.
}
```

If `SecretRecord` is defined as a Zod / similar schema, adapt accordingly.

- [ ] **Step 2: Add `softDelete(ref)` to Vault**

Open `src/vault/vault.ts`. Add this method to the class:

```typescript
async softDelete(ref: string): Promise<{ ref: string; deleted_at: string }> {
  const plaintext = await this.read();
  const idx = plaintext.secrets.findIndex((s) => s.ref === ref);
  if (idx === -1) {
    throw new ShuttleError("secret_not_found", `No secret with ref ${ref}.`);
  }
  if (plaintext.secrets[idx].deleted_at !== undefined) {
    throw new ShuttleError("secret_not_found", `Secret ${ref} is already deleted.`);
  }
  const now = new Date().toISOString();
  plaintext.secrets[idx] = { ...plaintext.secrets[idx], deleted_at: now };
  await this.write(plaintext);
  return { ref, deleted_at: now };
}
```

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
import type { DaemonServices } from "../../services.js";

interface DeleteBody {
  ref?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}

export function registerSecretsDeleteRoute(server: { addRoute: (method: "POST", path: string, handler: (req: IncomingMessage, body: unknown) => Promise<unknown>) => void }, services: DaemonServices): void {
  server.addRoute("POST", "/v1/secrets/delete", async (req, body) => {
    const b = (body ?? {}) as DeleteBody;
    if (typeof b.ref !== "string" || b.ref.length === 0) {
      throw new ShuttleError("missing_param", "ref is required.");
    }

    // Read the record first to determine environment for approval gating.
    const vault = await services.vault.read();
    const record = vault.secrets.find((s) => s.ref === b.ref);
    if (record === undefined) {
      throw new ShuttleError("secret_not_found", `No secret with ref ${b.ref}.`);
    }

    // Production-gated.
    if (record.environment === "production") {
      await requireApproval({
        store: services.approvals,
        binding: {
          action: "secrets-delete",
          ref: b.ref,
          environment: "production",
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: null,
          template_binary_path: null,
          template_binary_sha256: null,
          allowed_domains: record.allowed_domains ?? [],
          allowed_actions: record.allowed_actions ?? [],
        },
        daemonPort: services.daemonPort,
        approvalIdFromClient: b.approval_id,
        waitMs: b.wait_for_approval === false ? 0 : undefined,
      });
    }

    const result = await services.vault.softDelete(b.ref);
    return { deleted: true, ref: result.ref, deleted_at: result.deleted_at };
  });
}
```

**Adapt the `requireApproval` binding shape to match the existing `ApprovalBinding` interface — see `src/daemon/approvals/store.ts` for the canonical type. The above is illustrative; align fields with the real interface.**

- [ ] **Step 5: Register the route**

Open `src/daemon/api/router.ts` (the file that wires routes to the server). Add:

```typescript
import { registerSecretsDeleteRoute } from "./routes/secrets-delete.js";
// ... in the function that registers routes:
registerSecretsDeleteRoute(server, services);
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
import type { DaemonServices } from "../../services.js";

interface RotateBody {
  ref?: string;
  kind?: string; // generation kind for the new secret; defaults to random_32_bytes
  approval_id?: string;
  wait_for_approval?: boolean;
}

export function registerSecretsRotateRoute(
  server: { addRoute: (method: "POST", path: string, handler: (req: IncomingMessage, body: unknown) => Promise<unknown>) => void },
  services: DaemonServices,
): void {
  server.addRoute("POST", "/v1/secrets/rotate", async (req, body) => {
    const b = (body ?? {}) as RotateBody;
    if (typeof b.ref !== "string" || b.ref.length === 0) {
      throw new ShuttleError("missing_param", "ref is required.");
    }

    const vault = await services.vault.read();
    const oldRecord = vault.secrets.find((s) => s.ref === b.ref);
    if (oldRecord === undefined) {
      throw new ShuttleError("secret_not_found", `No secret with ref ${b.ref}.`);
    }

    const kind = typeof b.kind === "string" ? b.kind : "random_32_bytes";

    // Production-gated.
    if (oldRecord.environment === "production") {
      await requireApproval({
        store: services.approvals,
        binding: {
          action: "secrets-rotate",
          ref: b.ref,
          environment: "production",
          // ... shape matches ApprovalBinding; see store.ts
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: null,
          template_binary_path: null,
          template_binary_sha256: null,
          allowed_domains: oldRecord.allowed_domains ?? [],
          allowed_actions: oldRecord.allowed_actions ?? [],
        },
        daemonPort: services.daemonPort,
        approvalIdFromClient: b.approval_id,
        waitMs: b.wait_for_approval === false ? 0 : undefined,
      });
    }

    // Generate the new secret. The new ref has the same source/env/name as the
    // old but with a rotation suffix (e.g. -rot-<short-iso>).
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
      plan: [], // Plan 2 deliberately empty — audit-log destination synthesis is a follow-up.
      next_action: `Re-push the new secret to all destinations of ${b.ref}, then run: secret-shuttle secrets delete ${b.ref}`,
    };
  });
}
```

**Note:** the call `services.vault.generate(...)` assumes the vault has a `generate` method matching this shape. If the actual method name differs, adapt — the goal is "generate a new secret via the same code path that `secrets set` uses." If no such method exists yet, factor out the generate logic from the existing `POST /v1/secrets/generate` route into `services.vault.generate(...)`.

- [ ] **Step 5: Register route** — same pattern as Task A5 step 5.

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

**Behavior:** wraps a Commander action so that invoking the deprecated command:
1. Writes `[deprecated] <old> is now <new>. Will be removed in v0.3.0.` to stderr.
2. If the action's output flows through `outputJson`, includes a `warning: { message, deprecated, replacement }` object at top level.

Implementation strategy: `outputJson` already exists in `src/shared/result.ts`. We extend it (or add `outputJsonWithWarning`) to accept an optional warning. The `deprecated()` helper sets a context flag that `outputJson` reads.

For simplicity and DRY, use a module-level "pending warning" set by `deprecated()`, consumed by `outputJson` on the next call, then cleared. Single-threaded Node CLI process → safe.

- [ ] **Step 1: Failing tests**

Create `src/cli/deprecation.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPendingDeprecationWarning, consumePendingDeprecationWarning } from "./deprecation.js";

test("withPendingDeprecationWarning sets and consume retrieves once", () => {
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

test("consume without set returns null", () => {
  // Reset any prior state by consuming first.
  consumePendingDeprecationWarning();
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
 * Also writes the human-readable line to stderr immediately.
 */
export function withPendingDeprecationWarning(oldName: string, newName: string): void {
  const warning: DeprecationWarning = {
    message: `[deprecated] '${oldName}' is now '${newName}'. Will be removed in v0.3.0.`,
    deprecated: oldName,
    replacement: newName,
  };
  pending = warning;
  // stderr immediate: visible to humans regardless of --json mode.
  process.stderr.write(`${warning.message}\n`);
}

/** Pull and clear the pending warning (or null if none). */
export function consumePendingDeprecationWarning(): DeprecationWarning | null {
  const w = pending;
  pending = null;
  return w;
}
```

- [ ] **Step 4: Wire into `outputJson`**

Open `src/shared/result.ts`. Modify `outputJson`:

```typescript
import { consumePendingDeprecationWarning } from "../cli/deprecation.js";

export function ok<T extends Record<string, unknown>>(payload: T): T & { ok: true } {
  return {
    ok: true,
    ...payload,
  };
}

export function outputJson(value: unknown): void {
  const warning = consumePendingDeprecationWarning();
  if (warning !== null && typeof value === "object" && value !== null) {
    // Splice the warning into the output object.
    const enriched = { ...(value as Record<string, unknown>), warning };
    process.stdout.write(`${JSON.stringify(enriched, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
```

**Caveat:** this creates a circular import (`shared/result.ts` → `cli/deprecation.ts`). If the build complains, move `deprecation.ts` into `src/shared/` and update all imports. Or keep the warning state in `result.ts` itself with the public API exposed there. Pick whichever resolves the cycle cleanly — the test API stays the same.

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/cli/deprecation.ts src/cli/deprecation.test.ts src/shared/result.ts
git commit -m "feat(cli): deprecation helper — stderr line + JSON warning field"
```

---

### Task C2: `internal` command group + move power-user commands

**Files:**
- Create: `src/cli/commands/internal.ts`
- Modify: `src/cli/index.ts`
- Delete: `src/cli/commands/use-as-stdin.ts`

The `internal` group registers the following as subcommands (each just re-exports the existing Commander command):
- `unlock` (from `unlock.ts`)
- `compare` (from `compare.ts`)
- `migrate` (from `migrate.ts`) — note this is itself a group with `secure-vault` subcommand
- `blind` (from `blind.ts`)
- `capture` (from `capture.ts`)
- `inject` (from `inject.ts` — the V0 path, distinct from Plan 3's new `inject`)

Plus the four renamed-into-secrets commands stay as deprecated shims AT TOP LEVEL (so old scripts keep working for one release). The internal group does NOT shadow them.

- [ ] **Step 1: Create `src/cli/commands/internal.ts`**

```typescript
import { Command } from "commander";
import { unlockCommand } from "./unlock.js";
import { compareCommand } from "./compare.js";
import { migrateCommand } from "./migrate.js";
import { blindCommand } from "./blind.js";
import { captureCommand } from "./capture.js";
import { injectCommand } from "./inject.js";

export function internalCommand(): Command {
  const cmd = new Command("internal")
    .description("Power-user and deprecated commands. Most agents should not need these.");

  cmd.addCommand(unlockCommand());
  cmd.addCommand(compareCommand());
  cmd.addCommand(migrateCommand());
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

- [ ] **Step 5: Verify `internal --help` lists all six subcommands**

```bash
npm run build && node dist/cli/index.js internal --help 2>&1 | grep -E "unlock|compare|migrate|blind|capture|inject"
```

Expected: all six names appear.

- [ ] **Step 6: Verify top-level `--help` does NOT show `internal`**

```bash
node dist/cli/index.js --help 2>&1 | grep -c "internal"
```

Expected: 0 (or only as a docstring mention, not as a top-level command line).

- [ ] **Step 7: Smoke test specific internal commands work**

```bash
node dist/cli/index.js internal unlock --help
node dist/cli/index.js internal migrate --help
```

Both should print help text without "unknown command" errors.

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
import { withPendingDeprecationWarning } from "../deprecation.js";

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
import { consumePendingDeprecationWarning } from "../deprecation.js";

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
import { withPendingDeprecationWarning } from "../deprecation.js";

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

- [ ] **Step 5: Smoke test — stderr warning + JSON warning field both appear**

```bash
node dist/cli/index.js list --json 2>/tmp/stderr.log 1>/tmp/stdout.log
grep "deprecated" /tmp/stderr.log
grep "warning" /tmp/stdout.log
```

Both grep calls should match.

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
import { renderTopLevelHelp } from "./help.js";

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
  // Internal commands should NOT appear:
  assert.doesNotMatch(output, /\binternal\b/);
  assert.doesNotMatch(output, /^unlock\b/m); // old top-level deprecated; should NOT be in the curated help
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
 */
export function renderTopLevelHelp(): string {
  return [
    "secret-shuttle — Let AI agents use secrets without seeing them.",
    "",
    "Setup:",
    "  init                        Interactive first-run setup",
    "  status                      Daemon, vault, and browser health",
    "  daemon start|stop|restart   Lifecycle",
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

export function helpCommand(): Command {
  return new Command("help")
    .description("Show curated command list (or per-command help with: help <command>).")
    .argument("[command]", "Command name to show detailed help for.")
    .action(async (commandName: string | undefined) => {
      if (commandName === undefined) {
        process.stdout.write(renderTopLevelHelp());
        return;
      }
      // Per-command help: delegate to `secret-shuttle <command> --help`.
      // We can't easily call into the same Commander program from inside an
      // action without leaking state, so we just print a hint.
      process.stdout.write(`Run: secret-shuttle ${commandName} --help\n`);
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

## Part F — Verification + CHANGELOG

### Task F1: Full test suite verification

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
node dist/cli/index.js list --json 2>&1    # should emit deprecation warning to stderr + JSON warning field
node dist/cli/index.js internal --help      # should list 6 power-user commands
node dist/cli/index.js --help              # should NOT show 'internal' in command list
```

Expected:
- `help` prints the curated grouped list.
- `status --json` prints `{ ok: true, ready, next_action, report }`.
- `secrets list` succeeds (or fails with the daemon-not-running structured error).
- `list` succeeds with a `[deprecated] 'list' is now 'secrets list'. Will be removed in v0.3.0.` to stderr AND a `warning` field in the JSON output.
- `internal --help` shows the 6 commands.
- Top-level `--help` doesn't include `internal`.

- [ ] **Step 5: No-commit step (verification only)**

If all the above are green, proceed to F2.

---

### Task F2: CHANGELOG update

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append a `## Unreleased` entry** (or extend the existing one from Plan 1)

```markdown
### Added — Plan 2 (CLI surface)
- `secrets` command group (`list` / `get-ref` / `set` / `delete` / `rotate`). `set` is a rename of `generate`; `--kind paste` is reserved and rejected with a deferral hint (lands in Plan 4). `delete` is a soft-delete with audit trail. `rotate` generates a new ref and marks the old one as `rotating`; the destination re-push plan is empty in this release (audit-log destination synthesis is a follow-up).
- `status` command (rename of `doctor`) emits `ready: boolean` + `next_action: string | null` at the top level so agents can drive a state machine without inspecting nested fields. Existing `doctor` text formatting is preserved inside the `report` field.
- `internal` command group (hidden from default `--help`) absorbs `unlock`, `compare`, `migrate`, `blind`, `capture`, and the V0 `inject` for power users and scripts.
- `secret-shuttle help` curated progressive-disclosure entry — grouped one-line index of public commands, ≤30 lines.
- Per-command `--help` epilogs with copy-pasteable examples for every public command.

### Changed
- Old top-level commands `list`, `inspect`, `generate`, `doctor` remain available as deprecated shims that delegate to their `secrets *` / `status` replacement. Each emits a `[deprecated] ...` line to stderr AND a `warning: { message, deprecated, replacement }` field in JSON output. Scheduled for removal in v0.3.0.
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

**1. Spec coverage**

| Spec §11 deliverable | Task |
|---|---|
| `secret-shuttle status` (rename + shape extension) | B1 |
| `secret-shuttle secrets list` | A1 + A2 |
| `secret-shuttle secrets get-ref` | A1 + A3 |
| `secret-shuttle secrets set` (paste mode deferred) | A1 + A4 |
| `secret-shuttle secrets delete` | A5 |
| `secret-shuttle secrets rotate` (minimal scope) | A6 |
| `secret-shuttle help [command]` | D1 |
| `secret-shuttle internal *` namespace + commands moved | C2 |
| `POST /v1/secrets/delete` | A5 |
| `POST /v1/secrets/rotate` | A6 |
| Every command's `--help` has example in epilog | A2-A6, B1, D2 |
| Pre-existing HTTP error paths fix (carry-over from Plan 1 A4 review) | E1 |
| CHANGELOG | F2 |
| `secret-shuttle init` rewrite | NOT in Plan 2 — deferred to Plan 5a |
| `POST /v1/keychain/unlock` | NOT in Plan 2 — Plan 5a |
| `POST /v1/run/resolve` | NOT in Plan 2 — Plan 3 |
| `POST /v1/inject/render` | NOT in Plan 2 — Plan 3 |
| `POST /v1/approvals/session` | NOT in Plan 2 — Plan 4 |
| Single-window tab reuse | NOT in Plan 2 — Plan 4 (§5.10) |

**Gaps:** none for Plan 2's scope. Items deferred to Plans 3/4/5 are correctly flagged.

**2. Placeholder scan**

- No "TBD", "TODO", "implement later" in the plan.
- Every code block contains complete code.
- Every command shows expected output.

**3. Type consistency**

- `secretsCommand` / `secretsListCommand` / `secretsGetRefCommand` / `secretsSetCommand` / `secretsDeleteCommand` / `secretsRotateCommand` named consistently across the dispatcher (A1) and the individual files (A2–A6).
- `statusCommand`, `internalCommand`, `helpCommand` named consistently.
- `withPendingDeprecationWarning` / `consumePendingDeprecationWarning` named consistently between deprecation.ts (C1) and result.ts (C1) and shims (C3).
- `softDelete(ref)` and `markRotating(ref)` on Vault are referenced consistently between vault.ts changes (A5, A6) and the daemon endpoints (A5, A6).
- `DoctorReport` type from doctor.ts (preserved) is imported by status.ts (B1) — consistent.

**4. Scope check**

Plan 2 is one coherent CLI-surface migration. Two large units (secrets group + status) plus structural housekeeping (internal namespace, deprecation, help, server.ts fix). 15 tasks, each bite-sized. Estimated execution time: 4–5 hours for a fresh subagent doing one task at a time with TDD + verification.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-phase1-plan2-secrets-status-internal.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec compliance, then code quality) per task, review between tasks. Same pattern as Plan 1.

**2. Inline Execution** — Batch tasks in this session using `superpowers:executing-plans`.

Which approach?
