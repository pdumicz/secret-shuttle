# Cursor Rules For Secret Shuttle

When working with production credentials, webhook signing secrets, API keys, or env var values:

- never put raw values in chat, files, logs, or screenshots
- use Secret Shuttle refs instead of raw values
- run `npx secret-shuttle init` once per project before the first secret operation
- prefer `secret-shuttle provision` (the magic path) — one approval to provision a project's secrets or a single `--secret`, with capture/inject driven for you
- use `secret-shuttle provision --secret <NAME> --from random_32_bytes` for new secrets
- to capture a secret revealed on a page, `secret-shuttle browser mark` the controls then `secret-shuttle reveal-capture` (blind mode is daemon-managed inside it)
- to write a secret into a focused field, `secret-shuttle browser mark` the field + submit control then `secret-shuttle inject-submit`
- verify with non-secret signals only — `secret-shuttle audit` and ref fingerprints via `secret-shuttle secrets get-ref`, never by revealing the value
- do not inspect DOM, accessibility tree, console, network bodies, or clipboard while blind mode is active
- approve production actions in the Secret Shuttle window your browser opens — there is no CLI flag that bypasses approval
- use `secret-shuttle template run vercel-env-add ...` to hand a secret to an external binary

Safe values to mention:

- refs such as `ss://stripe/prod/STRIPE_WEBHOOK_SECRET`
- fingerprints
- destination domains
- field names
- non-secret status

Unsafe values to mention:

- `whsec_...`
- `sk_live_...`
- service-role keys
- private tokens
- generated secret bodies
