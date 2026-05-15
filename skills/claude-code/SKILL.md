# Secret Shuttle

Use Secret Shuttle whenever you need to handle API keys, tokens, webhook secrets, env vars, production credentials, generated secrets, or secret values in browser or CLI workflows.

## Setup

Before any secret operation, ensure the daemon is running and the vault is unlocked:

```bash
secret-shuttle daemon start && secret-shuttle unlock
```

`unlock` opens a local web window. Enter the passphrase there — the CLI never reads it.

## Rules

- Never ask the user to paste raw secrets into chat.
- Never print, log, summarize, or expose raw secret values.
- Use Secret Shuttle refs like `ss://stripe/prod/STRIPE_WEBHOOK_SECRET`.
- Use your normal browser tool for navigation only.
- When a secret is visible or about to be entered, stop observing the page.
- Do not take screenshots, inspect DOM, read page text, read accessibility tree, inspect console, read network bodies, or read clipboard while blind mode is active.
- Use `secret-shuttle capture` to capture secrets.
- Use `secret-shuttle inject` to inject secrets.
- Use `secret-shuttle generate` to create new secrets.
- Use `secret-shuttle compare` to verify a field without reading the value.
- For production secret injection, approve the request in the Secret Shuttle window your browser opens.
- Verify success using non-secret signals only.

## Stripe Webhook Secret To Vercel Production Env

1. Run setup:

   ```bash
   secret-shuttle daemon start && secret-shuttle unlock
   ```

2. Use the browser tool to navigate to Stripe webhook settings.
3. Create or reveal the webhook signing secret.
4. Stop browser observation.
5. Run:

   ```bash
   secret-shuttle blind start \
     --domain dashboard.stripe.com \
     --reason "capture Stripe webhook secret"
   ```

6. Focus the Stripe signing secret field or select the secret text.
7. Run:

   ```bash
   secret-shuttle capture \
     --name STRIPE_WEBHOOK_SECRET \
     --env production \
     --source stripe \
     --from focused-field \
     --allow-domain dashboard.stripe.com \
     --allow-domain vercel.com
   ```

   Approve the request in the Secret Shuttle window your browser opens.

8. End blind mode once the Stripe secret is no longer visible:

   ```bash
   secret-shuttle blind end
   ```

9. Navigate to Vercel project environment variables.
10. Enter safe metadata fields such as `STRIPE_WEBHOOK_SECRET` and `production`.
11. Focus the value field.
12. Stop browser observation.
13. Run:

    ```bash
    secret-shuttle inject \
      --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
      --to focused-field \
      --domain vercel.com
    ```

    Approve the request in the Secret Shuttle window your browser opens.

14. Save the env var.
15. Verify success without reading the value.

## Templates Instead Of Arbitrary Commands

Use `template run` to hand a secret to an external binary:

```bash
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --param name=STRIPE_WEBHOOK_SECRET \
  --param environment=production
```

## Production Approval

Production actions open a one-shot approval window in your browser. Approve the request there. There is no CLI flag that bypasses approval.

## Safe Output

It is safe to report:

- secret refs
- fingerprints
- domains
- names
- environments
- success/failure status

It is not safe to report raw secret values.
