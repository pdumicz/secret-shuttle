# Codex Instructions For Secret Shuttle

When handling secrets, route the secret moment through Secret Shuttle.

Setup before the first secret operation (Secret Shuttle is published to npm under the `beta` dist-tag):

```bash
npx secret-shuttle@beta init
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
# Provision a new local secret straight into a destination (one approval):
secret-shuttle provision --secret INTERNAL_CRON_SECRET \
  --from random_32_bytes \
  --environment production \
  --to vercel:production

# Capture a secret revealed on a page — mark the controls, then reveal-capture
# (blind mode is daemon-managed inside the transaction; you never see the value):
secret-shuttle browser mark pick --as reveal-btn
secret-shuttle browser mark focused --as revealed-field
secret-shuttle reveal-capture --name STRIPE_WEBHOOK_SECRET --env production \
  --source stripe --reveal-handle reveal-btn --field-handle revealed-field \
  --allow-domain dashboard.stripe.com

# Write a secret into a focused field and submit, verifying a success marker:
secret-shuttle browser mark focused --as value-field
secret-shuttle browser mark pick --as save-button
secret-shuttle inject-submit --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --field-handle value-field --submit-handle save-button --success-text "Saved"
```

To hand a secret to an external binary, use a template:

```bash
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --param name=STRIPE_WEBHOOK_SECRET \
  --param environment=production
```

Production actions require the human to approve in the Secret Shuttle window their browser opens. There is no CLI flag that bypasses approval.
