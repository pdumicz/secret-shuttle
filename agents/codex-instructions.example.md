# Codex Instructions For Secret Shuttle

When handling secrets, route the secret moment through Secret Shuttle.

Setup before the first secret operation:

```bash
npx secret-shuttle init
```

Do:

- navigate with the browser normally until a secret becomes visible or a secret value field is focused
- stop observing before the secret is visible to the model
- run Secret Shuttle commands from the terminal
- report only refs, fingerprints, and status
- approve production actions in the Secret Shuttle window your browser opens

Do not:

- ask the user to paste secret values
- read DOM or accessibility text while blind mode is active
- take screenshots while blind mode is active
- inspect console, network bodies, or clipboard while blind mode is active
- print raw values from `.env`, CLI output, or browser fields

Use:

```bash
secret-shuttle provision --secret INTERNAL_CRON_SECRET \
  --from random_32_bytes \
  --environment production \
  --to vercel:production
secret-shuttle capture --name STRIPE_WEBHOOK_SECRET --env production --source stripe --from focused-field
secret-shuttle inject --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET --to focused-field --domain vercel.com
secret-shuttle compare --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET --with focused-field
```

To hand a secret to an external binary, use a template:

```bash
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --param name=STRIPE_WEBHOOK_SECRET \
  --param environment=production
```

Production actions require the human to approve in the Secret Shuttle window their browser opens. There is no CLI flag that bypasses approval.
