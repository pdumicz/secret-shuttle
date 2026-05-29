# Stripe Webhook Secret To Vercel Production Env

Goal:

> Capture a Stripe webhook signing secret and inject it into Vercel production env vars without exposing the raw `whsec_...` value to the agent.

## Magic path

The fastest way to ship a Stripe webhook secret to Vercel production:

```bash
secret-shuttle provision \
  --secret STRIPE_WEBHOOK_SECRET \
  --from capture --url https://dashboard.stripe.com/webhooks \
  --to vercel:production
```

Secret Shuttle responds with `approval_required` — the local hub opens
showing one approval card. Click **Approve** (optionally check "Also
approve any matching shape for the next 15 min" if you'll be re-pushing
soon). Then the agent runs the continue step:

```bash
secret-shuttle provision --continue \
  --batch <batch_id_from_prior_step> \
  --approval-id <approval_id_from_prior_step>
```

The CLI navigates to Stripe in a daemon-owned browser, asks you to
reveal the webhook signing secret, captures the bytes into the vault
without exposing them to the agent, and pushes them to Vercel via the
`vercel-env-add` template. Final output:

```json
{
  "ok": true,
  "batch_status": "completed",
  "completed": 1,
  "refs": ["ss://stripe/prod/STRIPE_WEBHOOK_SECRET"]
}
```

Then the agent runs `secret-shuttle audit --since 1m --json` and pastes
the result to the user as proof.

---

## Advanced: low-level mechanics

The rest of this walkthrough covers the underlying primitives —
`browser start`, `browser mark`, `reveal-capture`, `inject-submit`,
`template run`. You don't need them for the magic path above; they're the
escape hatch when you need to debug a capture/inject flow step-by-step.

Blind mode is daemon-managed inside `reveal-capture` and `inject-submit` —
there is no manual `blind start`/`blind end` step in the modern flow. (If the
daemon ever returns `next: "manual_recovery_required"`, the human-approved
`secret-shuttle internal blind end` is the rare manual recovery; you do not
run it as part of the normal flow.)

## Prerequisites

```bash
npm install
npm run build
npm link
npx secret-shuttle init
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

## 2. Mark The Controls

Mark the reveal control and the field that will hold the revealed secret.
`mark pick` lets you click the target via the inspect overlay (no page event
fires); `mark focused` records the currently focused element. The daemon
stores an opaque handle keyed by `--as <label>` — you never see a selector.

```bash
secret-shuttle browser mark pick --as reveal-btn
secret-shuttle browser mark focused --as revealed-field
```

## 3. Capture The Secret

```bash
secret-shuttle reveal-capture \
  --name STRIPE_WEBHOOK_SECRET \
  --env production \
  --source stripe \
  --reveal-handle reveal-btn \
  --field-handle revealed-field \
  --allow-domain dashboard.stripe.com \
  --allow-domain vercel.com
```

`reveal-capture` clicks the marked reveal control, enters blind mode, captures
the revealed value into the vault, hides it, and auto-resumes observation only
if it can prove the secret is gone. While it runs, do not screenshot, inspect
DOM, read accessibility text, inspect console, read network bodies, or read the
clipboard — the daemon does that internally for the absence proof.

Approve the request in the Secret Shuttle window your browser opens.

Expected output shape:

```json
{
  "captured": true,
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "fingerprint": "sha256:...",
  "value_visible_to_agent": false
}
```

## 4. Navigate To Vercel

Use the browser agent to open the target Vercel project:

```text
Project -> Settings -> Environment Variables
```

Fill safe metadata:

- key: `STRIPE_WEBHOOK_SECRET`
- environment: `production`

Mark the value field and the Save control, then stop observing:

```bash
secret-shuttle browser mark focused --as value-field
secret-shuttle browser mark pick --as save-button
```

## 5. Inject And Submit The Secret

```bash
secret-shuttle inject-submit \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --field-handle value-field \
  --submit-handle save-button \
  --success-text "Saved" \
  --domain vercel.com
```

`inject-submit` injects the secret into the marked field, clicks the marked
Save control, waits for the `--success-text` marker to confirm the save, and
auto-resumes observation only if it can prove the secret is gone. Approve the
request in the Secret Shuttle window your browser opens.

Expected output shape:

```json
{
  "submitted": true,
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "value_visible_to_agent": false
}
```

## 6. Verify

`inject-submit` already clicked Save and confirmed the `--success-text`
marker. Confirm the result using non-secret signals only:

- success toast
- env var key appears in list
- deployment or redeploy status
- application webhook behavior
- `secret-shuttle audit --since 1m --json`

Do not reveal or read back the env var value.

## Template Alternative

Instead of manual injection, you can use the built-in template:

```bash
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --param name=STRIPE_WEBHOOK_SECRET \
  --param environment=production
```

The template runs the Vercel CLI with `shell: false` and never echoes the secret back to the agent.
