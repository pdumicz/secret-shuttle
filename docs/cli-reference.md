# CLI Reference

All successful commands return JSON. Raw secret values are never returned.

## `secret-shuttle daemon start | status | stop`

Manages the local daemon process. `start` spawns the daemon (detached), writes `~/.secret-shuttle/daemon-socket.json`, and refuses to run if `~/.secret-shuttle/master-key.json` from V0 is present (migrate first). `status` reports running/locked. `stop` sends SIGTERM.

## `secret-shuttle unlock`

Opens a local web window for the vault passphrase. The CLI never reads the passphrase. After unlock the daemon holds the master key in memory until lock or shutdown.

## `secret-shuttle migrate secure-vault`

Converts a V0 `master-key.json` + `vault.json.enc` into a V2 envelope. Prompts twice for a new passphrase. Deletes `master-key.json` on success. The daemon refuses to start until this is done.

## `secret-shuttle generate`

```bash
secret-shuttle generate \
  --name INTERNAL_CRON_SECRET \
  --env production \
  --kind random_32_bytes \
  --allow-domain vercel.com \
  --allow-action inject_submit
```

Production secrets prompt approval through the daemon UI. Use `--no-wait` to return `approval_required` without polling.

Supported `--kind` values: `random_32_bytes`, `base64url_32_bytes`, `hex_32_bytes`, `random_64_bytes`, `base64url_64_bytes`.

`--allow-action <action>` is repeatable; valid actions are `capture_from_page`, `inject_into_field`, `compare_fingerprint`, `use_as_stdin`, `inject_submit`. Omit it and the secret gets the default action set; supply one or more and it is granted exactly those — this is the explicit opt-in to grant `inject_submit` or to narrow scope. A force-rotate (`--force`) without `--allow-action` preserves the existing secret's actions (no silent widening); the approval UI shows the effective action scope.

## `secret-shuttle blind start | end`

Daemon-side blind state. `start` activates the CDP proxy filter for a domain. `end` clears it.

## `secret-shuttle capture`

```bash
secret-shuttle capture \
  --name STRIPE_WEBHOOK_SECRET \
  --env production \
  --source stripe \
  --from focused-field \
  --allow-domain dashboard.stripe.com \
  --allow-domain vercel.com
```

Requires active blind mode for the current page. The daemon snapshots the focused field metadata before asking for approval; capture is bound to that target + field.

## `secret-shuttle inject`

```bash
secret-shuttle inject \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --to focused-field \
  --domain vercel.com
```

The daemon opens the approval window; approve there. There is no CLI flag that bypasses approval.

## `secret-shuttle inject-submit`

```bash
secret-shuttle inject-submit \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --field-handle secret-field \
  --submit-handle save-button \
  --success-text "Environment Variable Added" \
  --domain vercel.com \
  --success-timeout-ms 15000
```

Before blind mode, mark the field and submit control with `secret-shuttle browser mark focused|pick --as <label>`; the daemon then owns the whole transaction (the agent's browser access is severed while the secret is on the page). The daemon injects the stored secret into the marked field, clicks the marked submit control, waits for the approved success marker, and proves the raw secret is absent from every daemon-observable surface. It always requires human approval through the daemon UI (it authorizes auto-resume; `--approval-id` / `--no-wait` work as elsewhere); the approval UI shows the field/submit labels, the success marker, and an explicit auto-resume disclosure. Observation auto-resumes only if the success marker was observed and the absence proof passed; otherwise blind mode stays active and the response is `next: "manual_recovery_required"`, which the agent must surface to the human to run `secret-shuttle blind end` — the agent must not resume itself. The handles are revalidated and the submit handle must be on the same page/target + domain as the field handle (fail-closed), and the secret's `allowed_actions` must include `inject_submit` (no implicit grant from `inject_into_field`). Responses are enum-only and never contain the raw secret or any observed page text. Whether auto-resume succeeds in practice on a given provider's pages is best-effort; if a site forces manual recovery the secret was still written safely under blind mode and `secret-shuttle blind end` is the recovery. Unlike `inject`, which only writes the secret into the focused field and leaves a human to save and end blind manually, `inject-submit` also clicks submit, verifies success, and auto-resumes only if the secret is proven gone.

## `secret-shuttle compare`

```bash
secret-shuttle compare \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --with focused-field
```

Returns `{ "matches": true | false, ... }` without printing either value.

## `secret-shuttle template list`

Lists vetted templates. The daemon never executes anything except a registered template; an agent cannot inject argv or stdin around them.

## `secret-shuttle template run <template-id>`

```bash
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_SECRET_KEY \
  --param name=STRIPE_SECRET_KEY \
  --param environment=production
```

Each template delivers the secret to the provider CLI either via **true stdin** (the value is written to the child's stdin and never appears anywhere else) or via a daemon-owned **`0600` env-file** (the daemon creates `~/.secret-shuttle/tmp/<random>.env` with mode `0600` containing exactly `NAME=VALUE\n`, passes the path as `--env-file <path>`, and unlinks the file in a `finally`; a startup-force + periodic sweep additionally clears anything left by an abnormally-killed prior run). The secret value never appears in the child's argv or env; only the random env-file path appears in argv when `tmp_env_file_0600` delivery is used (the path is non-secret).

Built-in templates today:

- **`vercel-env-add`** — `vercel env add <name> <environment>`. Delivery: **stdin**. Required params: `name=`, `environment=` (one of `production`, `preview`, `development`). `destinationEnvironment` from `environment`.
- **`github-actions-secret-set`** — `gh secret set <name> --repo <owner/repo>`. Delivery: **stdin**. Required params: `name=`, `repo=` (`owner/repo`). `destinationEnvironment` is always `repo`. Environment-scoped (`--env`) and org-scoped (`--org`) secrets are **rejected** with `invalid_template_param`: GitHub's per-scope argv is mutually-exclusive (`--env` requires `--repo`, `--org` excludes `--repo`), so one template cannot safely express both shapes without risking a divergence between the human-approved destination and the executed argv. The per-scope follow-ups (`github-actions-env-secret-set`, `github-actions-org-secret-set`) are tracked in [docs/templates-deferred.md](./templates-deferred.md).
- **`cloudflare-secret-put`** — `wrangler secret put <name>`. Delivery: **stdin**. Required params: `name=`. Optional: `env` (Wrangler environment). `destinationEnvironment` is `env` when set, else `production`.
- **`supabase-edge-secret-set`** — `supabase secrets set --env-file <path>`. Delivery: **`tmp_env_file_0600`** (the Supabase CLI does not accept true stdin portably; `/dev/stdin` is not available on Windows). Required params: `name=`. Optional: `project_ref`. `destinationEnvironment` is `project_ref` when set, else `production`.

Deferred templates (`github-actions-env-secret-set`, `github-actions-org-secret-set`, `railway-variable-set`, `netlify-env-set`, `clerk-env-set`) and the reopen criteria are documented in [docs/templates-deferred.md](./templates-deferred.md).

## `secret-shuttle browser start`

Launches Chrome under the daemon via `--remote-debugging-pipe` and returns the filtered CDP proxy URL:

```json
{ "started": true, "proxy_url": "ws://127.0.0.1:.../cdp/...", "raw_cdp_url": null }
```

The agent uses the proxy URL only.

To override the Chrome binary, create `~/.secret-shuttle/daemon.config.json` (mode 0600 recommended) with:

```json
{ "version": 1, "chromePath": "/absolute/path/to/Chrome", "chromeSha256": "<optional lowercase sha256 of that file>" }
```

before running `secret-shuttle daemon start`. The agent cannot influence this file through the CLI/API. When `chromeSha256` is set, the daemon refuses to launch if the binary's hash does not match.

## `secret-shuttle list | inspect`

Metadata-only views, scoped by `--env` / `--source` for `list`.

## `secret-shuttle use-as-stdin`

Refused in Secure Mode. Returns error `removed_in_secure_mode`. Use `template run` instead.

## `secret-shuttle doctor`

Reports whether the daemon, vault, browser, policy, and local files are in a safe state. Text mode prints labelled lines; `--json` emits machine-readable JSON wrapping the full `/v1/health` response under `health`.

The `agentic flows:` line in the text output reports `available` when the daemon's browser is started AND the CDP proxy is active AND the daemon build supports handles (always true after Phases 1–3). When that line is `unavailable (start browser)`, run `secret-shuttle browser start` to enable the agentic browser flows (`inject-submit`, `reveal-capture`). The same flag is exposed under `health.agentic_browser.available` in `--json` mode.

## `secret-shuttle agent install <claude|codex|cursor|copilot>`

Installs the canonical Secret Shuttle skill into the project's current working directory. Per target:

- `claude` → `.claude/skills/secret-shuttle/SKILL.md` (wholesale overwrite — Secret Shuttle owns this file).
- `codex` → `AGENTS.md` (marker-managed snippet between `<!-- secret-shuttle:begin -->` / `<!-- secret-shuttle:end -->`; preserves the rest of the file; re-running replaces only the marked block).
- `cursor` → `.cursor/rules/secret-shuttle.mdc` (wholesale overwrite).
- `copilot` → `.github/copilot-instructions.md` (marker-managed snippet, same convention as codex).

The skill content is the bundled `skills/secret-shuttle/SKILL.md` shipped with the package — installs do not hit the network. Writes are atomic (temp + rename) and idempotent (a second run with identical input produces a byte-identical file). The command operates exclusively on `process.cwd()`; it never writes to your home directory or any global path.

## `secret-shuttle agent print-skill-url`

Prints the raw GitHub URL of the canonical SKILL.md on one line of stdout, suitable for pasting into any agent that supports a remote skill URL. The URL is derived from the `repository` field in the shipped `package.json` (no hardcoded URLs — defense against fork/rename drift). Override the default `main` branch with `--branch <name>` or `--ref <name>`.
