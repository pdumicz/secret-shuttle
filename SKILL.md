# secret-shuttle

Local-daemon CLI that lets AI coding agents use secrets without ever seeing them. The agent works with refs (`ss://stripe/prod/STRIPE_KEY`); the daemon owns every plaintext moment.

## Why

You — the agent — can read files and run commands. Anything that touches `.env`, runs `cat ~/.aws/credentials`, or processes a secret in your context is a credential leak. Secret Shuttle gives you refs to operate with, and the daemon resolves them at the last possible moment (into a child process's env, or its stdin) without the bytes ever entering your context.

## Usage

```bash
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
- **Responses are JSON**. Errors are `{"ok": false, "error_code": "...", "message": "...", "hint": "...", "exit_code": N}`. Always read `error_code` first.

## When NOT to use these commands

- Never pass a secret you obtained as a bare argument — it would be in your context. Always use refs.
- Never `cat .env` or `echo $SECRET` to verify a value — that is a leak. Use `secrets list` / `secrets get-ref`.
- Never run `reveal-capture` or `inject-submit` yourself — those are developer-driven flows (they click in the browser). You can suggest the next command.

## Recovery (error_code → next action)

| error_code | Cause | What to do |
|---|---|---|
| `daemon_not_running` | Daemon is not started. | `secret-shuttle daemon start` |
| `vault_not_initialized` | No vault exists yet. | `secret-shuttle init` |
| `legacy_key_present` | V0 vault present; must migrate. | `secret-shuttle migrate secure-vault` |
| `vault_locked` | Daemon running but vault is locked. | `secret-shuttle unlock` (browser window for passphrase) |
| `approval_required` | Production-gated op needs developer approval. | Hub window opens automatically. Wait, or use `--no-wait` to get an `approval_id` and retry with `--approval-id <id>` after approving. For combined env+stdin ops, `details.approvals` lists each `approval_id`. |
| `approval_expired` | The approval id aged out (2 min window). | Re-run without `--approval-id`; daemon mints a fresh one. |
| `approval_denied` | Developer clicked Deny. | Explain what was denied; ask for guidance. |
| `secret_not_found` | Ref doesn't exist in the vault. | `secret-shuttle secrets list --env <env>` to see what's available. |
| `browser_not_started` | Browser flows need the daemon's browser. | `secret-shuttle browser start` |
| `bad_request` / `missing_param` | Wrong input shape. | Read `message`; usually a missing or malformed flag. |
| `secret_exists` | Ref already exists. | Re-run with `--force` to overwrite. |

## Tell the developer before approval-gated ops

Before any operation that will open an approval window, say in plain English what you're about to do. Example: "I'm going to push the Stripe webhook secret to Vercel production — please approve in the popup." After every operation, surface the result: `ok`, refs used, destinations pushed to.

If `error_code` isn't in the table above, surface it verbatim — do not paraphrase.

## Low-level surface (rare)

`daemon start/stop/status`, `unlock`, `init`, `migrate secure-vault`, `secrets delete`, `secrets rotate`, `compare`, `inject`, `inject-submit`, `reveal-capture`, `capture`, `blind start/end`, `browser start/mark/marks`, `template list`, `internal session create/list/revoke`. Run `secret-shuttle <cmd> --help` for details.

## Install this skill into a project

```bash
secret-shuttle agent install claude   # writes .claude/skills/secret-shuttle/SKILL.md
secret-shuttle agent install codex    # marker-managed snippet in AGENTS.md
secret-shuttle agent install cursor   # writes .cursor/rules/secret-shuttle.mdc
secret-shuttle agent install copilot  # marker-managed snippet in .github/copilot-instructions.md
```
