# Secret Shuttle

Let AI agents use secrets without seeing them.

Secret Shuttle is a local blind-secret bridge for Claude Code, Codex, Cursor, Browser Harness, Playwright, and browser-using agents. It lets agents capture, store, generate, compare, and inject production secrets through browser and CLI workflows without exposing raw values to the model.

```text
Claude Code / Codex / Browser Harness
    |
    | navigates dashboard
    v
Sensitive field reached
    |
    | calls Secret Shuttle
    v
Secret Shuttle captures/injects locally
    |
    v
Agent receives only ss://... refs, fingerprints, and status
```

## Why This Exists

AI coding agents can build and deploy real apps, but production configuration is still a dangerous handoff. Webhook secrets, API keys, service-role keys, and production env vars often get copied through chat, screenshots, DOM dumps, terminal logs, or `.env` files.

Secret Shuttle keeps the secret moment local. The agent can decide what needs to happen, while Secret Shuttle handles the raw value.

The agent sees metadata like this:

```json
{
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "name": "STRIPE_WEBHOOK_SECRET",
  "environment": "production",
  "fingerprint": "sha256:ab91...",
  "value_visible_to_agent": false
}
```

The agent never gets a command that returns the raw `whsec_...`, `sk_live_...`, or service-role value.

## Current Status

This repo is a V0 OSS prototype.

Implemented now:

- TypeScript CLI distributed as `secret-shuttle`
- local encrypted JSON vault
- `ss://source/env/name` secret refs
- secret generation
- metadata-only list and inspect
- cooperative blind mode state
- focused-field or selected-text capture over Chrome CDP
- focused-field injection over Chrome CDP
- focused-field comparison by fingerprint
- production approval prompt for production injection and stdin use
- stdin handoff for CLIs without printing raw values
- Claude Skill, AGENTS.md, Cursor, and Codex instruction examples
- Stripe to Vercel demo walkthrough

Not implemented in V0:

- enforced screenshot or DOM blocking
- CDP proxy
- cloud sync
- team vaults
- Chrome extension
- MCP server
- platform-specific Stripe, Vercel, Supabase, Clerk, or GitHub Actions adapters

## Installation

From this repo:

```bash
npm install
npm run build
npm link
```

Then initialize local storage:

```bash
secret-shuttle init
```

For one-off local runs without linking:

```bash
npm run build
node dist/cli/index.js init
```

## Quickstart

Generate a local production secret:

```bash
secret-shuttle generate \
  --name INTERNAL_CRON_SECRET \
  --env production \
  --kind random_32_bytes \
  --allow-domain vercel.com
```

List metadata only:

```bash
secret-shuttle list --env production
```

Inspect metadata only:

```bash
secret-shuttle inspect ss://local/prod/INTERNAL_CRON_SECRET
```

Start a Chrome session Secret Shuttle can reach:

```bash
secret-shuttle browser start --profile prod-config
```

Or start Chrome yourself with remote debugging:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.secret-shuttle/browser-profiles/prod-config"
```

Capture a visible secret after stopping browser observation:

```bash
secret-shuttle blind start \
  --domain dashboard.stripe.com \
  --reason "capture Stripe webhook signing secret"

secret-shuttle capture \
  --name STRIPE_WEBHOOK_SECRET \
  --env production \
  --source stripe \
  --from focused-field \
  --allow-domain dashboard.stripe.com \
  --allow-domain vercel.com
```

Inject into a focused production env var field:

```bash
secret-shuttle inject \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --to focused-field \
  --domain vercel.com
```

For non-interactive scripts, the confirmation must be explicit:

```bash
secret-shuttle inject \
  --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET \
  --to focused-field \
  --domain vercel.com \
  --confirm-production PRODUCTION
```

## Stripe To Vercel Demo

The first demo target is:

> Claude Code or Codex configures a production Vercel env var using a Stripe webhook secret it never sees.

Flow:

1. Agent opens Stripe and creates or reveals a webhook signing secret.
2. Agent stops observing the page.
3. Secret Shuttle starts cooperative blind mode.
4. Secret Shuttle captures the focused field and stores the value locally.
5. Agent receives only `ss://stripe/prod/STRIPE_WEBHOOK_SECRET`.
6. Agent opens Vercel production environment variables.
7. Agent fills safe metadata like the key name.
8. Agent focuses the value field.
9. Secret Shuttle injects the value locally after production approval.
10. Agent saves and verifies success using non-secret signals only.

Detailed walkthrough: [examples/stripe-to-vercel/walkthrough.md](examples/stripe-to-vercel/walkthrough.md)

## Security Model

Secret Shuttle separates two planes:

```text
Agent Plane
- navigates browser
- reasons about config
- fills safe metadata fields
- sees refs, fingerprints, labels, and status

Secret Plane
- generates secrets
- captures raw values
- encrypts and stores values locally
- injects values into focused fields or stdin
- never returns raw values to the agent
```

V0 uses cooperative blind mode. The agent is instructed not to take screenshots, inspect DOM, read the accessibility tree, inspect console output, or read clipboard contents while secrets are visible. Future versions should add enforced blind mode through a controlled browser session and CDP proxy.

Read more:

- [docs/security-model.md](docs/security-model.md)
- [docs/threat-model.md](docs/threat-model.md)

## Vault Storage

V0 stores an encrypted JSON vault at:

```text
~/.secret-shuttle/vault.json.enc
```

The local master key is stored at:

```text
~/.secret-shuttle/master-key.json
```

This encrypts the vault at rest, but local-file key storage is not as strong as OS keychain-backed storage. OS keychain integration is planned for a later version.

## CLI Reference

See [docs/cli-reference.md](docs/cli-reference.md).

Core commands:

```bash
secret-shuttle init
secret-shuttle browser start
secret-shuttle blind start --domain dashboard.stripe.com --reason "capture Stripe webhook secret"
secret-shuttle capture --name STRIPE_WEBHOOK_SECRET --env production --source stripe --from focused-field
secret-shuttle inject --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET --to focused-field
secret-shuttle generate --name INTERNAL_CRON_SECRET --env production --kind random_32_bytes
secret-shuttle compare --ref ss://stripe/prod/STRIPE_WEBHOOK_SECRET --with focused-field
secret-shuttle use-as-stdin --ref ss://stripe/prod/STRIPE_SECRET_KEY --command "vercel env add STRIPE_SECRET_KEY production"
secret-shuttle list
secret-shuttle inspect ss://stripe/prod/STRIPE_WEBHOOK_SECRET
secret-shuttle blind end
```

## Agent Instructions

Ship one of these into your agent environment:

- [skills/claude-code/SKILL.md](skills/claude-code/SKILL.md)
- [agents/AGENTS.md.example](agents/AGENTS.md.example)
- [agents/codex-instructions.example.md](agents/codex-instructions.example.md)
- [agents/cursor-rules.example.md](agents/cursor-rules.example.md)

The core agent rule is simple:

> Navigate normally. When a secret is visible or about to be entered, stop observing and call Secret Shuttle.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Roadmap

- V1: Secret Shuttle-owned browser sessions, stronger focused-field detection, better approval UI.
- V2: enforced blind mode through a CDP proxy that blocks screenshots, DOM extraction, AX tree extraction, console reads, unsafe runtime evaluation, and network body reads during sensitive windows.
- V3: platform workflow helpers for Vercel, Stripe, Supabase, Clerk, GitHub Actions, Cloudflare, and Railway.
- V4: 1Password, Bitwarden, Doppler, Infisical, AWS Secrets Manager, GCP Secret Manager, and HashiCorp Vault integrations.
- V5: team policy, approval workflows, audit receipts, RBAC, SSO, and managed sync.

## License

MIT
