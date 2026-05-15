# Codex Instructions For Secret Shuttle

When handling secrets, route the secret moment through Secret Shuttle.

Do:

- navigate with the browser normally until a secret becomes visible or a secret value field is focused
- stop observing before the secret is visible to the model
- run Secret Shuttle commands from the terminal
- report only refs, fingerprints, and status

Do not:

- ask the user to paste secret values
- read DOM or accessibility text while blind mode is active
- take screenshots while blind mode is active
- inspect console, network bodies, or clipboard while blind mode is active
- print raw values from `.env`, CLI output, or browser fields

Use:

```bash
secret-shuttle generate --name INTERNAL_CRON_SECRET --env production --kind random_32_bytes --allow-domain vercel.com
secret-shuttle capture --name STRIPE_WEBHOOK_SECRET --env production --source stripe --from focused-field --allow-domain dashboard.stripe.com --allow-domain vercel.com
secret-shuttle inject --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET --to focused-field --domain vercel.com
secret-shuttle compare --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET --with focused-field
```

Production injection requires the human to approve by typing `PRODUCTION`, unless the human explicitly allowed `--confirm-production PRODUCTION`.
