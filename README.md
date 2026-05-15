# Secret Shuttle

Let AI agents use secrets without seeing them.

> **Status: 0.1.1 — early prototype. Do not trust this with real production secrets yet.**
>
> Secret Shuttle V0 is a cooperative-mode prototype. It cannot enforce that another tool on your machine refrains from screenshotting, reading the DOM, or scraping the clipboard while a secret is visible. Enforced Secure Mode (daemon-owned vault and CDP proxy) is being implemented under the `secure-v2` branch and is not yet released. Use this only on test accounts and throwaway secrets.

Secret Shuttle is a local bridge that lets coding agents like Claude Code, Codex, Cursor, and browser-using agents capture, store, generate, compare, and inject secrets through browser and CLI workflows. The agent sees only refs like `ss://stripe/prod/STRIPE_WEBHOOK_SECRET`, fingerprints, and status — never the raw value.

## Install (from source)

```bash
npm install
npm run build
npm link
secret-shuttle init
```

## Quickstart

```bash
secret-shuttle generate \
  --name INTERNAL_CRON_SECRET \
  --env production \
  --kind random_32_bytes \
  --allow-domain vercel.com

secret-shuttle list --env production
secret-shuttle inspect ss://local/prod/INTERNAL_CRON_SECRET
```

For browser capture/injection see [examples/stripe-to-vercel/walkthrough.md](examples/stripe-to-vercel/walkthrough.md).

## What Works Today (0.1.1)

- TypeScript CLI distributed as `secret-shuttle`
- local encrypted JSON vault and `ss://source/env/name` refs
- generate, capture (focused field / selection), inject, compare
- cooperative blind-mode flag (advisory, not enforced)
- production approval prompt (terminal)

## What Does Not Work Yet

- enforced screenshot, DOM, AX-tree, console, network-body, or clipboard blocking
- daemon-owned vault key
- daemon-issued, context-bound approvals
- CDP proxy
- OS-keychain or passphrase-backed key storage
- team vaults, cloud sync, MCP server, browser extension
- platform-specific Stripe, Vercel, Supabase, Clerk, GitHub Actions adapters

These are tracked in `docs/superpowers/plans/2026-05-15-secret-shuttle-secure-v2.md` (Secure Mode V2).

## Docs

- [docs/security-model.md](docs/security-model.md)
- [docs/threat-model.md](docs/threat-model.md)
- [docs/cli-reference.md](docs/cli-reference.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/roadmap.md](docs/roadmap.md)

## License

MIT
