# secret-shuttle

Local-daemon CLI that lets AI coding agents use secrets without ever seeing them. The agent works with refs (`ss://stripe/prod/STRIPE_KEY`); the daemon owns every plaintext moment.

## Why

You — the agent — can read files and run commands. Anything that touches `.env`, runs `cat ~/.aws/credentials`, or processes a secret in your context is a credential leak. Secret Shuttle gives you refs to operate with, and the daemon resolves them at the last possible moment (into a child process's env, or its stdin) without the bytes ever entering your context.

## Usage

```bash
# Provision an entire project's secrets in one approval — primary path for new projects:
secret-shuttle bootstrap
# → Phase 1: reads secret-shuttle.yml, diffs vs vault, opens hub for one approval.
#   Returns approval_required with details.batch_id + details.approvals[0].approval_id.

# Phase 2: after human approves in the hub UI:
secret-shuttle bootstrap --continue --batch <batch-id> --approval-id <approval-id>
# → { completed, refs, errors } — all secrets generated and pushed to destinations.

# Run a command with refs resolved into its env — secret values never enter your context:
secret-shuttle run --env-file=.env -- npm start

# Pipe a secret to stdin (gh auth login style):
secret-shuttle run --stdin=ss://local/prod/GH_TOKEN -- gh auth login --with-token

# Combined env + stdin:
secret-shuttle run --env-file=.env --stdin=ss://local/prod/TOKEN -- gh auth login --with-token

# Discover what refs are available:
secret-shuttle secrets list
secret-shuttle secrets list --env production
secret-shuttle secrets get-ref ss://stripe/prod/STRIPE_KEY

# Import an existing .env file into the vault (one command, no manual per-key set):
secret-shuttle import --env-file .env
secret-shuttle import --env-file .env.production --env production

# Store a new secret (returns a ref; value is never returned):
secret-shuttle secrets set --name STRIPE_KEY --env production --source stripe

# Push a ref to a provider via a vetted template (Vercel, GitHub Actions, Cloudflare, Supabase):
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_SECRET_KEY \
  --param name=STRIPE_SECRET_KEY \
  --param environment=production

# Check daemon + vault health:
secret-shuttle status
secret-shuttle status --json
```

## The contract

- **You see**: refs (`ss://source/env/NAME`), metadata, fingerprints, status, error codes.
- **You never see**: raw secret values, vault keys, browser CDP URL, OS credentials.
- **Every production-environment operation requires human approval** (one click in a browser window the daemon opens automatically). Dev/local ops auto-approve.
- **Responses are JSON**. Errors are `{"ok": false, "error_code": "...", "message": "...", "hint": "...", "exit_code": N, "next_action": "<command or null>"}`. Always read `error_code` first. When `next_action` is a non-null string, run it for automatic recovery. When `next_action` is null, human intervention is required.

## Authentication

Every daemon request carries a bearer token of the shape `<agent_id>.<hmac>`, where `<hmac>` is HMAC-SHA256 derived from the daemon's root_token (stored at `<SHUTTLE_HOME>/root-token`, mode 0600). The agent_id is the attribution identity; the hmac proves the token was minted by something that had access to the root.

- **Auto-derived agent_id per runtime.** Each agent runtime (e.g. `claude`, `codex`, `cursor`, `copilot`) gets a deterministic, per-(machine, runtime) agent_id via `deriveAutoAgentId(runtime, machine_id)`. Same machine + same runtime = same id; reinstalling the skill doesn't churn identities.
- **`secret-shuttle init` writes per-runtime tokens** to user-private runtime config (e.g. `~/.claude/settings.json` for Claude, `~/.codex/config.toml` for Codex). Subsequent calls in that runtime auto-resolve the token via `resolveDaemonToken`.
- **Sub-agents mint child tokens.** A parent agent spawning a sub-agent must call `POST /v1/tokens/mint` (or `secret-shuttle agent mint --child-id <id>`) so the sub-agent's calls attribute correctly. The mint endpoint derives the child token using the same HMAC scheme — no shared secret needed between parent and child.
- **Threat model: attribution + hygiene, not hard isolation.** Tokens prevent accidental cross-agent confusion and give per-agent audit lines. They do NOT protect against a malicious local process running as the same user — anyone with read access to `<SHUTTLE_HOME>/root-token` can mint any agent_id they want. The OS user boundary is the real trust boundary.
- **Revocation: `secret-shuttle daemon rotate`.** Regenerates the root_token on disk and hot-swaps it in memory. All previously derived tokens become invalid immediately; every agent runtime must re-init.
- **machine-id reset: `secret-shuttle daemon reset-machine-id`.** Changes future agent_id derivation (e.g. after restoring from a backup onto new hardware) but does NOT invalidate existing tokens. To invalidate, run `daemon rotate`.

## Memory hygiene (best-effort)

The master key is zeroed on lock and on every in-flight crypto operation; copies are scrubbed synchronously before any async continuation. Byte buffers built for child-process stdin and tmp env-file writes are scrubbed after the consumer reads them. Masker pattern and lookback buffers are scrubbed on stream dispose.

Secret values returned by the vault AND captured values from the browser are JS strings, which V8 does not let us proactively zero — they linger in heap until garbage collection. A post-launch hardening plan (5q) refactors both to Buffer for end-to-end scrub; required for security-audit deployments.

## When NOT to use these commands

- Never pass a secret you obtained as a bare argument — it would be in your context. Always use refs.
- Never `cat .env` or `echo $SECRET` to verify a value — that is a leak. Use `secrets list` / `secrets get-ref`.
- Never run `reveal-capture` or `inject-submit` yourself — those are developer-driven flows (they click in the browser). You can suggest the next command.

## Recovery (error_code → next action)

Every error JSON now includes a `next_action` field. When it is a non-null string, run that command for automatic recovery. When it is null, human intervention is required.

| error_code | `next_action` | Cause | What to do |
|---|---|---|---|
| `daemon_not_running` | `secret-shuttle daemon start` | Daemon is not started. | Run the next_action. |
| `vault_not_initialized` | `secret-shuttle init` | No vault exists yet. | Run the next_action. |
| `legacy_key_present` | `secret-shuttle migrate secure-vault` | V0 vault present; must migrate. | Run the next_action. |
| `vault_locked` | `secret-shuttle unlock` | Daemon running but vault is locked. | Run the next_action (opens browser window for passphrase). |
| `browser_not_started` | `secret-shuttle browser start` | Browser flows need the daemon's browser. | Run the next_action. |
| `daemon_invalid_response` | `secret-shuttle daemon status` | Daemon returned a malformed response. | Run the next_action, then retry. |
| `daemon_start_timeout` | `secret-shuttle daemon status` | Daemon did not start in time. | Run the next_action, then retry. |
| `approval_required` | null (human required) | Production-gated op needs developer approval. | Hub window opens automatically. Wait, or use `--no-wait` to get an `approval_id` and retry with `--approval-id <id>` after approving. For combined env+stdin ops, `details.approvals` lists each `approval_id`. |
| `approval_expired` | null | The approval id aged out (2 min window). | Re-run without `--approval-id`; daemon mints a fresh one. |
| `approval_denied` | null (human required) | Developer clicked Deny. | Explain what was denied; ask for guidance. |
| `secret_not_found` | null | Ref doesn't exist in the vault. | `secret-shuttle secrets list --env <env>` to see what's available. |
| `bad_request` / `missing_param` | null | Wrong input shape. | Read `message`; usually a missing or malformed flag. |
| `secret_exists` | null | Ref already exists. | Re-run with `--force` to overwrite. |
| `keychain_key_invalid` | `secret-shuttle unlock` | Cached key didn't decrypt the vault (device-migration, corruption). | Daemon already falls back to passphrase UI automatically; run `unlock` if the browser window didn't open. |
| `daemon_start_failed` | `secret-shuttle daemon status` | `init` spawned the daemon but it didn't respond within 5 s. | Run the next_action to check daemon logs, then retry `init`. |
| `bootstrap_plan_invalid` | null | `secret-shuttle.yml` is malformed or uses an unsupported source kind. | Read `message` for the exact field/line. Fix the yml and retry. |
| `bootstrap_batch_not_found` | null | `--batch <id>` refers to a batch that doesn't exist or was already abandoned. | Run `secret-shuttle bootstrap --list` to see current batches. |
| `bootstrap_destination_unknown` | null | A destination shorthand in the yml couldn't be resolved to a known template. | Check the shorthand format: `vercel:<env>`, `github-actions:<owner/repo>`, `cloudflare:<env>`, `supabase:<project>`. |

## Tell the developer before approval-gated ops

Before any operation that will open an approval window, say in plain English what you're about to do. Example: "I'm going to push the Stripe webhook secret to Vercel production — please approve in the popup." After every operation, surface the result: `ok`, refs used, destinations pushed to.

If `error_code` isn't in the table above, surface it verbatim — do not paraphrase.

## Provisioning a new project (bootstrap)

When setting up a new project, write a `secret-shuttle.yml` describing every secret and its destinations, then run the two-phase bootstrap flow. One human approval covers the entire plan — no per-secret popups.

```yaml
version: 1
secrets:
  DATABASE_URL:
    source: { kind: random_32_bytes }
    destinations:
      - vercel:production
      - github-actions:owner/repo
  STRIPE_SECRET_KEY:
    source: { kind: existing, ref: ss://stripe/prod/STRIPE_SECRET_KEY }
    destinations:
      - vercel:production
```

Destination shorthands: `vercel:<env>`, `github-actions:<owner/repo>`, `cloudflare:<env>`, `supabase:<project>`.

### Capture sources always require approval

Any yml plan containing `source: { kind: capture, url }` always requires human approval, regardless of `--environment` and destination class — auto-approve is disabled for capture plans. The approval gate is needed so the hub URL is available for the capture coordinator UI; without it the user has no rendered surface to click Capture.

### Blind-mode discipline for bootstrap captures

When a capture step starts, the executor auto-starts blind mode pinned to the URL's expected host. The flow:

- The daemon-owned browser navigates to the user's URL; the user focuses the secret field in that page and clicks Capture in the hub UI coordinator.
- Capture re-verifies the host at capture time. If the page redirected mid-flow, the step records `bootstrap_capture_redirect_blocked` and the value is discarded.
- After a successful capture: blank target → verify → close target → verify → blind auto-ends. Each verify confirms the page no longer holds the secret in DOM or CDP state.
- If cleanup verification fails: blind STAYS active, the step records `bootstrap_capture_cleanup_failed`, the executor stops, and the batch ends in `status=failed_partial`. Human intervention is required.
- If the bootstrap-owned browser is then stopped (in the route's `finally`), blind auto-resumes since no rendering process remains to observe.

### Batch ownership

Bootstrap batches are owned by the agent that called `/plan`. `owner_agent_id` is stamped from the ALS AuthContext at plan time. Only the owner (or root) can `/continue`, `/abandon`, or see the batch in `/list`. Cross-owner non-root access returns `bootstrap_batch_not_found` (existence non-disclosure — same code as a batch that genuinely doesn't exist). The same ownership model applies to `ApprovalGrant` and `SessionGrant` via `owner_agent_id`.

## Low-level surface (rare)

`bootstrap --list / --abandon`, `daemon start/stop/status`, `unlock`, `init`, `keychain enable/disable/status`, `migrate secure-vault`, `secrets delete`, `secrets rotate`, `compare`, `inject`, `inject-submit`, `reveal-capture`, `capture`, `blind start/end`, `browser start/mark/marks`, `template list`, `internal session create/list/revoke`. Run `secret-shuttle <cmd> --help` for details.

## Install this skill into a project

```bash
secret-shuttle agent install claude   # writes .claude/skills/secret-shuttle/SKILL.md
secret-shuttle agent install codex    # marker-managed snippet in AGENTS.md
secret-shuttle agent install cursor   # writes .cursor/rules/secret-shuttle.mdc
secret-shuttle agent install copilot  # marker-managed snippet in .github/copilot-instructions.md
```
