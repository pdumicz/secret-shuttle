# Plan 5g — `secret-shuttle bootstrap` Design

**Status:** Approved, ready for plan-writing.

**Goal:** Ship the Script 2 magic command from the original product vision: dev says *"set up Stripe, Supabase, and the cron secret in Vercel production and GitHub Actions"*; agent runs `secret-shuttle bootstrap`. Daemon returns a plan covering every secret + source + destination. Human clicks ONE approval. Agent runs `bootstrap --continue --batch <id> --approval-id <id>`; daemon orchestrates all captures, generates, and template pushes. One command, one approval, one retry.

## Position vs. the May-21 arch doc

The arch doc at `docs/superpowers/specs/2026-05-21-agent-native-cli-redesign-design.md:13` rejected `bootstrap` as a "magical do-everything command", arguing the magic should live in the approval flow (pre-approved sessions, batched grants) rather than in a CLI verb. That argument was correct in its premise (composable primitives matter) but underweighted the cost of pushing plan-translation decisions into agent prompts. Plan 5g ships `bootstrap` as a **thin orchestrator over existing primitives**. Primitives stay unchanged — bootstrap reads the yml, computes the diff, mints one approval, calls the existing routes. No new vault logic, no new approval semantics.

---

## Architecture

**Two-phase contract**, mirroring Plan 4d's `--no-wait` shape:

- **Phase 1 — plan** (`POST /v1/bootstrap/plan`): reads `secret-shuttle.yml`, reads vault state, computes the diff (what's missing), mints one `ApprovalBinding` of action `"bootstrap"` with the full plan in `template_params`, persists the batch state to disk, and returns `approval_required` with the `approval_id` + `batch_id` in `details`. No daemon-side execution yet.

- **Phase 2 — continue** (`POST /v1/bootstrap/continue`): consumes the approval, walks the batch's plan, calls existing primitives for each step (`/v1/secrets/generate`, `/v1/secrets/reveal-capture`, `/v1/templates/run`), records per-step results, returns enum.

**Single approval covers all steps.** The `bootstrap` ApprovalBinding's existence (consumed once at Phase 2 entry) authorizes the daemon to run every step in the persisted plan WITHOUT additional inner approvals. Per-step audit rows preserve the forensic trail.

**Diff-based idempotency.** Re-running bootstrap with the same yml is safe: secrets already in the vault + already pushed to all their destinations are skipped. `--force` overrides for explicit re-generation / re-push (rotation lives in `secrets rotate`).

**Partial-success semantics.** Steps that fail don't abort the run. Final result includes `completed`, `failed`, and `errors[]`. `bootstrap --continue --batch <same-id>` is idempotent and re-walks the plan, retrying failed steps.

---

## Components

### 1. Plan format — `secret-shuttle.yml`

**File:** `./secret-shuttle.yml` (cwd, version-controlled). Override path with `--plan-file <path>`.

```yaml
version: 1
secrets:
  STRIPE_WEBHOOK_SECRET:
    source:
      kind: capture
      url: https://dashboard.stripe.com/webhooks
    destinations:
      - vercel:production
      - github-actions:owner/repo
  SUPABASE_SERVICE_ROLE:
    source:
      kind: capture
      url: https://supabase.com/dashboard/project/<id>/settings/api
    destinations:
      - vercel:preview
      - github-actions:owner/repo
  INTERNAL_CRON_SECRET:
    source:
      kind: random_32_bytes
    destinations:
      - vercel:production
```

**Source kinds:**

| Kind | Behavior |
|---|---|
| `capture` (requires `url`) | Daemon opens the URL in the daemon-owned browser; human reveals via existing reveal-capture flow. |
| `random_32_bytes` | Daemon generates a 32-byte random value via existing `secrets generate` route. |
| `random_64_bytes` | Same, 64 bytes. |
| `existing` (requires `ref`) | Skip generation; use the existing vault ref. Source step is a no-op; only destinations run. |

**Destination shorthand:** `<provider>:<scope>` resolves to a `(template_id, template_params)` pair via `src/cli/bootstrap/destination-shorthand.ts`. Current mappings:

- `vercel:production`, `vercel:preview`, `vercel:development` → `vercel-env-add` with `environment=<scope>`.
- `github-actions:<owner/repo>` → `github-actions-secret-set` with `repo=<owner/repo>`.
- `cloudflare:<env>` → `cloudflare-secret-put` with the env scope.
- `supabase:<project>` → `supabase-edge-secret-set` with the project ref.

(The four mappings reflect the four shipped templates. Out of scope: shorthands for deferred templates like railway / netlify.)

**Validation** (Phase 1, before approval mint):

- Schema validation via a lightweight YAML parser + manual shape check (no external schema lib).
- Each `source.kind` recognized; required fields present.
- Each destination shorthand resolves to a known template.
- Secret name matches `^[A-Z][A-Z0-9_]*$` (standard env-var shape).
- Production-environment destinations explicitly flagged in the plan (auditing + UI rendering).

Validation failures throw `bad_request` with the specific shape error before any side effects.

### 2. Approval binding — `action: "bootstrap"`

A new `ApprovalBinding.action` value: `"bootstrap"`. Distinct from `run` / `inject` / `template` because the human's review covers an entire batch, not a single primitive call.

**Binding shape:**
```ts
{
  action: "bootstrap",
  ref: null,
  environment: "production",  // worst-case environment in the plan
  destination_domain: null,
  target_id: null,
  field_fingerprint: null,
  template_id: null,
  template_params: {
    batch_id: "bootstrap-<uuid>",
    plan_summary: JSON.stringify({
      secrets: [
        { name: "STRIPE_WEBHOOK_SECRET", source: "capture:stripe.com", destinations: ["vercel:production", "github-actions:owner/repo"] },
        ...
      ]
    }),
  },
  allowed_domains: <union of all destination domains>,
}
```

The hub UI renders `template_params.plan_summary` as a per-secret list with source + destinations. ONE [Approve] button.

**Production gating:** if ANY destination is production-environment, the entire batch requires approval (binding's `environment = "production"`). If ALL destinations are dev, the binding gets `environment: "development"` and the synth path runs without UI (matches existing dev-env behavior).

### 3. Hub UI rendering

`src/daemon/approvals/ui.html` needs a renderer for the `bootstrap` action. The existing per-binding view renders single-operation cards. The bootstrap view shows:

```
Bootstrap (3 secrets):

  ▸ STRIPE_WEBHOOK_SECRET
    Source: capture from stripe.com
    Destinations: vercel:production, github-actions:owner/repo

  ▸ SUPABASE_SERVICE_ROLE
    Source: capture from supabase.com
    Destinations: vercel:preview, github-actions:owner/repo

  ▸ INTERNAL_CRON_SECRET
    Source: random_32_bytes
    Destinations: vercel:production

[Approve] [Deny]
```

Rendered via the existing `human[]` copy-strings pattern (extended with a `bootstrap` entry).

### 4. Batch state — `BootstrapStore`

**File:** `src/daemon/bootstrap/store.ts`.

In-memory `Map<batchId, BatchState>` + disk persistence in `~/.secret-shuttle/bootstrap-batches/<batch-id>.json` (mode 0600). State shape:

```ts
interface BatchState {
  batch_id: string;
  approval_id: string;
  plan_file_path: string;
  plan: PlanEntry[];  // computed diff (only steps that need running)
  step_results: Record<string, StepResult>;  // per-step outcome
  created_at: number;
  status: "pending" | "in_progress" | "completed" | "failed_partial";
}

interface PlanEntry {
  secret: string;  // env var name
  ref: string;     // ss://<source>/<env>/<name>
  source: { kind: "capture"; url: string } | { kind: "random_32_bytes" } | { kind: "random_64_bytes" } | { kind: "existing"; ref: string };
  destinations: Array<{ shorthand: string; template_id: string; template_params: Record<string, string> }>;
}

interface StepResult {
  ok: boolean;
  ref?: string;
  destinations_pushed?: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }>;
  error_code?: string;
  message?: string;
}
```

**Lifecycle:**
- Phase 1 creates the state, status: `"pending"`.
- Phase 2 transitions to `"in_progress"`, walks plan, transitions to `"completed"` or `"failed_partial"`.
- `--continue` on an already-completed batch is a fast no-op (returns the cached result).

**Cleanup:** batches older than 24h are pruned on daemon start. `secret-shuttle bootstrap --abandon <batch-id>` for manual cleanup.

### 5. Executor

**File:** `src/daemon/bootstrap/executor.ts`.

`executeBatch(batchId, services)`:
1. Load batch state.
2. For each `PlanEntry` not in `step_results` (or marked failed):
   - **Source step**: 
     - `capture` → daemon-owned browser opens URL → existing reveal-capture flow → ref committed to vault.
     - `random_32_bytes` → existing `secrets generate` route programmatically.
     - `existing` → no-op; ref already in vault.
   - **Destination steps**: for each `(template_id, template_params)`, call existing `/v1/templates/run` programmatically (it accepts a pre-approved binding via the bootstrap approval's authority — see §6).
   - On step success: record `StepResult { ok: true, ref, destinations_pushed: [...] }`.
   - On step failure: record `StepResult { ok: false, error_code, message }`. Continue to next entry.
3. Save batch state.
4. Return aggregate result.

**Pacing:** sequential per entry; per-entry destination pushes can be parallelized OR kept sequential. **Sequential for v1** — simpler error handling, predictable hub UX, no template-CLI concurrency surprises. Parallel is a future optimization.

### 6. Inner-call approval authority

The trick: existing routes (`/v1/secrets/generate`, `/v1/templates/run`, etc.) require their OWN approvals. Bootstrap's Phase 2 holds a `bootstrap` approval but the inner calls would normally trigger their own `requireApprovals` calls.

**Solution:** introduce a `ApprovalStore.useBootstrapAuthority(batchId, innerBinding)` method. When the executor calls into existing route logic, it bypasses the inner `requireApprovals` by:
- Passing a `bootstrap_authority: { batch_id }` context flag in the internal call.
- The inner route's approval gating checks: if `bootstrap_authority` set AND the bootstrap approval (looked up by batch_id) covers the inner binding's action/env/template_id (via a per-binding-action allow list), skip `requireApprovals`.

This is a small change to ~4 inner routes (generate, reveal-capture, set, templates/run). They get an optional `_internalBootstrapContext` parameter that auths from the bootstrap binding.

**Alternative considered + rejected:** mint per-step approvals from the bootstrap context and consume them inline. Cleaner conceptually but doubles the approval-store traffic. The bypass-with-context approach is more performant and matches what the user approved.

### 7. CLI surface

**`src/cli/commands/bootstrap.ts`** — single file, no subcommand group.

```
secret-shuttle bootstrap [--plan-file <path>] [--force]
secret-shuttle bootstrap --continue --batch <batch-id> --approval-id <approval-id> [--force]
secret-shuttle bootstrap --abandon <batch-id>
secret-shuttle bootstrap --list
```

`--list` returns persisted batch states. `--abandon` removes a batch from the store + deletes its disk state. Useful for cleanup.

Bootstrap's own flag set is small. `--approval-id` is repeatable (shared with the existing factory from Plan 4d) but bootstrap mints exactly one approval, so callers pass exactly one id. If they pass multiple, the route rejects with `bad_request`.

### 8. Audit

Two new `DaemonAuditAction` values:

- `bootstrap_plan` — emitted when Phase 1 mints the approval. Records `batch_id`, `plan_file_path`, secret count, destination count.
- `bootstrap_step` — emitted per step in Phase 2. Records `batch_id`, `secret`, `step` (`source` or `destination_<id>`), `ok`, plus existing per-action fields (ref, environment, template_id, domain).

Audit log is the source of truth for forensics. Batch state is operational; audit is durable history.

### 9. Error registry additions

Three new codes:

- `bootstrap_plan_invalid` (USAGE / exit 2): yml validation failure. `next_action: "Edit secret-shuttle.yml and re-run secret-shuttle bootstrap"`.
- `bootstrap_batch_not_found` (NOT_FOUND / exit 3): `--continue --batch <id>` for an unknown / pruned batch. `next_action: "secret-shuttle bootstrap  # generate a fresh batch"`.
- `bootstrap_destination_unknown` (USAGE / exit 2): yml destination shorthand doesn't resolve. Message names the failing entry.

`ref_conflict` (an existing error code if present; add if not) for the case where a yml-declared ref exists in the vault with a different value and `--force` is not set.

### 10. Test plan

**Unit:**
- `src/cli/bootstrap/yml.test.ts`: parser + validator (valid plan, missing fields, unknown source, unknown destination, bad name pattern).
- `src/cli/bootstrap/destination-shorthand.test.ts`: each shorthand resolves to correct template.
- `src/daemon/bootstrap/plan.test.ts`: diff logic (already-in-vault skip, partial-push detect, --force override).
- `src/daemon/bootstrap/store.test.ts`: persistence, load, prune, abandon.
- `src/daemon/bootstrap/executor.test.ts`: walks plan, records results, partial success, retry idempotency.

**Integration:**
- `src/daemon/api/routes/bootstrap.test.ts`: `/v1/bootstrap/plan` returns approval_required + batch_id; `/v1/bootstrap/continue` consumes approval + executes via mocked inner routes.
- Cold flow: empty vault → plan with 3 secrets → approval_required → approve → continue → all 3 in vault + destinations pushed.
- Idempotent re-run: same yml after success → plan is empty → fast `ok: true, completed: 0` enum.
- Partial-success: mock one destination to fail → result has `failed > 0` and `errors[].secret` is correct; retry with same batch resumes from the failure point.

**E2E (optional, gated):**
- Real reveal-capture flow with a stub provider page (low priority; the existing reveal-capture E2E covers the underlying mechanic).

### 11. CHANGELOG + docs

- CHANGELOG `Plan 5g` section under Unreleased.
- `docs/cli-reference.md`: new `bootstrap` section with examples.
- `SKILL.md`: replace the "compose primitives" example with a `bootstrap` example as the primary path. Keep primitives as the fallback path.

---

## Fold-in: init-test wording fix

The `init --no-keychain does NOT touch keychain` test (from a prior batch) is technically inaccurate — init still calls `/v1/keychain/disable`, which invokes `isAvailable`/`delete`. The security property is "no master key read/write, no fast-path unlock, no C2 enrollment." Rename:

```ts
test("init --no-keychain: does NOT read or write the master key during the run", ...);
```

Single line touch, folded into Plan 5g's pre-work.

---

## Implementation order (informs plan task ordering)

1. yml parser + validator (`src/cli/bootstrap/yml.ts`).
2. Destination shorthand resolver (`src/cli/bootstrap/destination-shorthand.ts`).
3. `ApprovalBinding.action` union extended with `"bootstrap"`.
4. Hub UI renderer for bootstrap action (`ui.html` + `human[]` extension).
5. BootstrapStore (`src/daemon/bootstrap/store.ts`).
6. Plan + diff (`src/daemon/bootstrap/plan.ts`).
7. Inner-call bootstrap authority hook (~4 route files patched).
8. Executor (`src/daemon/bootstrap/executor.ts`).
9. `/v1/bootstrap/plan` + `/v1/bootstrap/continue` + `/v1/bootstrap/abandon` + `/v1/bootstrap/list` routes (`src/daemon/api/routes/bootstrap.ts`).
10. Error codes (`bootstrap_plan_invalid`, `bootstrap_batch_not_found`, `bootstrap_destination_unknown`, possibly `ref_conflict`).
11. CLI command (`src/cli/commands/bootstrap.ts`).
12. Audit actions (`bootstrap_plan`, `bootstrap_step`).
13. Init-test wording fix (pre-work).
14. CHANGELOG + docs + final verification.

---

## Out of scope

- Inference from `.env.example` / `vercel.json` / `wrangler.toml`. Explicit yml only.
- `provision` (single-intent inline) and `use` (one-off injection). Future plans.
- Parallel destination pushes per secret. Sequential v1.
- New templates beyond the existing 4. Bootstrap composes what's there.
- Rotation via bootstrap. `secrets rotate` remains the rotation path.
- MCP wrapper. Defer indefinitely per arch doc.

---

## Decisions locked

- Bootstrap ships despite arch doc deferral (§0).
- ONE `bootstrap` approval binding covers the whole plan (§2).
- Scope to bootstrap only; defer provision and use (§7).

---

**End of design.**
