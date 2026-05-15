# CLI Reference

All successful commands return JSON. Raw secret values are never returned.

## `secret-shuttle init`

Initializes local storage.

```bash
secret-shuttle init
```

Creates:

```text
~/.secret-shuttle/config.json
~/.secret-shuttle/master-key.json
~/.secret-shuttle/vault.json.enc
```

## `secret-shuttle browser start`

Starts Chrome with remote debugging enabled.

```bash
secret-shuttle browser start --profile prod-config --port 9222
```

Output includes the CDP URL:

```json
{
  "cdp_url": "http://127.0.0.1:9222"
}
```

## `secret-shuttle blind start`

Starts cooperative blind mode.

```bash
secret-shuttle blind start \
  --domain dashboard.stripe.com \
  --reason "capture Stripe webhook signing secret"
```

While blind mode is active, the agent must not use screenshots, DOM inspection, accessibility-tree reads, console reads, network-body reads, or clipboard reads.

## `secret-shuttle blind end`

Ends cooperative blind mode.

```bash
secret-shuttle blind end
```

## `secret-shuttle generate`

Generates and stores a new secret locally.

```bash
secret-shuttle generate \
  --name INTERNAL_CRON_SECRET \
  --env production \
  --kind random_32_bytes \
  --allow-domain vercel.com
```

Supported kinds:

- `random_32_bytes`
- `base64url_32_bytes`
- `hex_32_bytes`
- `random_64_bytes`
- `base64url_64_bytes`

## `secret-shuttle capture`

Captures selected text or a focused field value from a CDP-connected Chrome page.

```bash
secret-shuttle capture \
  --name STRIPE_WEBHOOK_SECRET \
  --env production \
  --source stripe \
  --from focused-field \
  --allow-domain dashboard.stripe.com \
  --allow-domain vercel.com
```

Options:

- `--from focused-field`
- `--from selection`
- `--cdp-url http://127.0.0.1:9222`
- `--force`

Capture requires active cooperative blind mode for the current domain.

## `secret-shuttle inject`

Injects a stored secret into the focused browser field.

```bash
secret-shuttle inject \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --to focused-field \
  --domain vercel.com
```

Production secrets require approval:

```bash
secret-shuttle inject \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --to focused-field \
  --domain vercel.com \
  --confirm-production PRODUCTION
```

## `secret-shuttle compare`

Compares selected text or a focused field value to a stored secret fingerprint.

```bash
secret-shuttle compare \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --with focused-field
```

Output:

```json
{
  "matches": true,
  "value_visible_to_agent": false
}
```

## `secret-shuttle use-as-stdin`

Runs a command with a stored secret supplied through stdin.

```bash
secret-shuttle use-as-stdin \
  --ref ss://stripe/prod/STRIPE_SECRET_KEY \
  --command "vercel env add STRIPE_SECRET_KEY production"
```

By default, command stdout and stderr are not included. To debug, use:

```bash
secret-shuttle use-as-stdin \
  --ref ss://local/prod/INTERNAL_CRON_SECRET \
  --command "some-command" \
  --show-output \
  --confirm-production PRODUCTION
```

When output is shown, Secret Shuttle redacts the exact known value and common secret patterns.

## `secret-shuttle list`

Lists metadata only.

```bash
secret-shuttle list --env production
```

## `secret-shuttle inspect`

Inspects metadata only.

```bash
secret-shuttle inspect ss://stripe/prod/STRIPE_WEBHOOK_SECRET
```
