# Demo Script

Opening line:

> I built Secret Shuttle, a local bridge that lets Claude Code use production secrets without seeing them.

Scene 1:

- Agent opens Stripe.
- Agent creates a webhook endpoint.
- Stripe reveals the signing secret.
- Agent says it is stopping observation before the secret is handled.

Scene 2:

```bash
secret-shuttle blind start \
  --domain dashboard.stripe.com \
  --reason "capture Stripe webhook signing secret"
```

```bash
secret-shuttle capture \
  --name STRIPE_WEBHOOK_SECRET \
  --env production \
  --source stripe \
  --from focused-field \
  --allow-domain dashboard.stripe.com \
  --allow-domain vercel.com
```

Narration:

> Secret Shuttle stores the raw value locally and gives the agent only a ref and fingerprint.

Scene 3:

- Agent opens Vercel project settings.
- Agent fills `STRIPE_WEBHOOK_SECRET`.
- Agent focuses the value field and stops observing.

Scene 4:

```bash
secret-shuttle inject \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --to focused-field \
  --domain vercel.com
```

Approval prompt:

```text
Type PRODUCTION to continue:
```

Narration:

> The model still does not know the `whsec_...` value. The local runtime injects it into the focused field.

Scene 5:

- Agent saves the env var.
- Agent verifies the success toast and key name only.

Closing line:

> Password managers help agents log in. Secret Shuttle helps agents configure production secrets.
