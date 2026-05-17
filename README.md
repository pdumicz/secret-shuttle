# Secret Shuttle

Let AI agents use secrets without seeing them.

> **Status: 0.1.1 — early prototype. Do not trust this with real production secrets yet.**
>
> Secure Mode V2 (daemon-owned vault, CDP proxy, approval UI) has landed on `main`. It has been through several rounds of adversarial security review with fixes, but it has **not** been independently audited or released as a versioned package. Treat it as an early prototype: use only with test accounts and throwaway secrets.

Secret Shuttle is a local bridge that lets coding agents — Claude Code, Codex, Cursor, browser-using agents — capture, generate, store, compare, and inject secrets through browser and CLI workflows. The agent sees only refs like `ss://stripe/prod/STRIPE_WEBHOOK_SECRET`, fingerprints, field metadata, and status — never the raw value.

## How Secure Mode Works

```text
Agent CLI (untrusted client)
        |
        | localhost HTTP, bearer token from ~/.secret-shuttle/daemon-socket.json
        v
Secret Shuttle daemon
  - vault key (in memory only, after passphrase unlock through web UI)
  - approval grants (single-use, 2-min TTL, bound to action/ref/domain/target/field/template)
  - browser owner — talks raw CDP over a pipe
  - filtered CDP WebSocket proxy exposed to the agent
  - safe command-template runner (no shell, no arbitrary commands)
```

The daemon owns every secret moment. The agent sees refs and status, never raw values, never the raw Chrome CDP URL, never the vault key.

## Install (from source)

```bash
npm install
npm run build
npm link
secret-shuttle daemon start
secret-shuttle unlock
```

`unlock` opens a local web window — you enter the passphrase there. The CLI never reads it.

## Quickstart

```bash
secret-shuttle generate \
  --name INTERNAL_CRON_SECRET \
  --env production \
  --kind random_32_bytes \
  --allow-domain vercel.com
# (production secret — approve in the window the daemon opens)

secret-shuttle list --env production
secret-shuttle inspect ss://local/prod/INTERNAL_CRON_SECRET
```

For the full browser walkthrough see [examples/stripe-to-vercel/walkthrough.md](examples/stripe-to-vercel/walkthrough.md).

## Templates Instead of Arbitrary Commands

```bash
secret-shuttle template list
secret-shuttle template run vercel-env-add \
  --ref ss://stripe/prod/STRIPE_SECRET_KEY \
  --param name=STRIPE_SECRET_KEY \
  --param environment=production
```

Templates run vetted binaries with `shell: false`, absolute paths only, and never echo stdout/stderr back to the agent.

## What Works Today (0.1.1)

- TypeScript CLI distributed as `secret-shuttle`
- Local daemon with bearer-authenticated HTTP API on 127.0.0.1
- Passphrase-derived envelope around the vault master key (scrypt + AES-256-GCM)
- `ss://source/env/name` refs
- Generate, capture (focused field / selection), inject, compare — all routed through the daemon
- Approval UI with one-shot, context-bound grants for production actions
- Daemon-owned Chrome over `--remote-debugging-pipe`
- Filtered WebSocket CDP proxy that blocks screenshots, DOM, accessibility, runtime, console, log, and network-body reads during blind mode
- Built-in `vercel-env-add` command template
- Exact-by-default domain matching (`*.example.com` for wildcards)
- Migration command: `secret-shuttle migrate secure-vault`

## What Does Not Work Yet

- OS-keychain or hardware-backed key storage
- Team vaults, cloud sync, MCP server, browser extension
- Platform-specific helpers for Stripe, Supabase, Clerk, GitHub Actions, Cloudflare, Railway
- Signed desktop binaries

## Docs

- [docs/security-model.md](docs/security-model.md)
- [docs/threat-model.md](docs/threat-model.md)
- [docs/cli-reference.md](docs/cli-reference.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/roadmap.md](docs/roadmap.md)

## License

MIT
