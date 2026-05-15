# Stripe Webhook Secret To Vercel Production Env

Goal:

> Capture a Stripe webhook signing secret and inject it into Vercel production env vars without exposing the raw `whsec_...` value to the agent.

## Prerequisites

```bash
npm install
npm run build
npm link
secret-shuttle init
secret-shuttle browser start --profile prod-config
```

Use the Chrome window started by Secret Shuttle for the demo.

## 1. Navigate To Stripe

Use your normal browser agent to open Stripe Dashboard and create or reveal the webhook signing secret.

Safe actions:

- click through settings
- create webhook endpoint
- fill non-secret URL and event fields
- reveal the signing secret button

Stop browser observation before reading the revealed value.

## 2. Start Blind Mode

```bash
secret-shuttle blind start \
  --domain dashboard.stripe.com \
  --reason "capture Stripe webhook signing secret"
```

Do not screenshot, inspect DOM, read accessibility text, inspect console, read network bodies, or read clipboard while blind mode is active.

## 3. Capture The Secret

Focus the Stripe signing secret field or select the secret text.

```bash
secret-shuttle capture \
  --name STRIPE_WEBHOOK_SECRET \
  --env production \
  --source stripe \
  --from focused-field \
  --allow-domain dashboard.stripe.com \
  --allow-domain vercel.com
```

Expected output shape:

```json
{
  "captured": true,
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "fingerprint": "sha256:...",
  "value_visible_to_agent": false
}
```

End blind mode after the secret is hidden or the page is no longer visible:

```bash
secret-shuttle blind end
```

## 4. Navigate To Vercel

Use the browser agent to open the target Vercel project:

```text
Project -> Settings -> Environment Variables
```

Fill safe metadata:

- key: `STRIPE_WEBHOOK_SECRET`
- environment: `production`

Focus the value field and stop observing.

## 5. Inject The Secret

```bash
secret-shuttle inject \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --to focused-field \
  --domain vercel.com
```

Approve production injection by typing:

```text
PRODUCTION
```

Expected output shape:

```json
{
  "injected": true,
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "value_visible_to_agent": false
}
```

## 6. Save And Verify

Save the Vercel env var.

Verify using non-secret signals only:

- success toast
- env var key appears in list
- deployment or redeploy status
- application webhook behavior

Do not reveal or read back the env var value.
