# Cursor Rules For Secret Shuttle

When working with production credentials, webhook signing secrets, API keys, or env var values:

- never put raw values in chat, files, logs, or screenshots
- use Secret Shuttle refs instead of raw values
- use `secret-shuttle generate` for new secrets
- use `secret-shuttle capture` after stopping page observation
- use `secret-shuttle inject` into a focused field
- use `secret-shuttle compare` to verify without revealing the value
- do not inspect DOM, accessibility tree, console, network bodies, or clipboard while blind mode is active

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
