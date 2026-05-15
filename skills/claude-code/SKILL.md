# Secret Shuttle

Use Secret Shuttle whenever you need to handle API keys, tokens, webhook secrets, env vars, production credentials, generated secrets, or secret values in browser or CLI workflows.

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
- For production secret injection, require explicit user approval.
- Verify success using non-secret signals only.

## Stripe Webhook Secret To Vercel Production Env

1. Use the browser tool to navigate to Stripe webhook settings.
2. Create or reveal the webhook signing secret.
3. Stop browser observation.
4. Run:

   ```bash
   secret-shuttle blind start \
     --domain dashboard.stripe.com \
     --reason "capture Stripe webhook secret"
   ```

5. Focus the Stripe signing secret field or select the secret text.
6. Run:

   ```bash
   secret-shuttle capture \
     --name STRIPE_WEBHOOK_SECRET \
     --env production \
     --source stripe \
     --from focused-field \
     --allow-domain dashboard.stripe.com \
     --allow-domain vercel.com
   ```

7. End blind mode once the Stripe secret is no longer visible:

   ```bash
   secret-shuttle blind end
   ```

8. Navigate to Vercel project environment variables.
9. Enter safe metadata fields such as `STRIPE_WEBHOOK_SECRET` and `production`.
10. Focus the value field.
11. Stop browser observation.
12. Run:

    ```bash
    secret-shuttle inject \
      --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
      --to focused-field \
      --domain vercel.com
    ```

13. Save the env var.
14. Verify success without reading the value.

## Production Approval

If Secret Shuttle prompts:

```text
Type PRODUCTION to continue:
```

pause for the human user unless they explicitly provided permission to use `--confirm-production PRODUCTION`.

## Safe Output

It is safe to report:

- secret refs
- fingerprints
- domains
- names
- environments
- success/failure status

It is not safe to report raw secret values.
