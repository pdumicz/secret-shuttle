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
  --allow-domain vercel.com
```

Production secrets prompt approval through the daemon UI. Use `--no-wait` to return `approval_required` without polling.

Supported `--kind` values: `random_32_bytes`, `base64url_32_bytes`, `hex_32_bytes`, `random_64_bytes`, `base64url_64_bytes`.

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

## `secret-shuttle compare`

```bash
secret-shuttle compare \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --with focused-field
```

Returns `{ "matches": true | false, ... }` without printing either value.

## `secret-shuttle template list`

Lists vetted templates.

## `secret-shuttle template run <template-id>`

```bash
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_SECRET_KEY \
  --param name=STRIPE_SECRET_KEY \
  --param environment=production
```

Built-in templates today: `vercel-env-add`.

## `secret-shuttle browser start`

Launches Chrome under the daemon via `--remote-debugging-pipe` and returns the filtered CDP proxy URL:

```json
{ "started": true, "proxy_url": "ws://127.0.0.1:.../cdp/...", "raw_cdp_url": null }
```

The agent uses the proxy URL only.

## `secret-shuttle list | inspect`

Metadata-only views, scoped by `--env` / `--source` for `list`.

## `secret-shuttle use-as-stdin`

Refused in Secure Mode. Returns error `removed_in_secure_mode`. Use `template run` instead.
