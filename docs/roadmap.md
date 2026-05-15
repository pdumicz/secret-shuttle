# Roadmap

## V0 — OSS Prototype (released)

Cooperative blind mode, CLI, local encrypted vault, focused-field CDP capture/injection, stdin handoff, agent instructions, Stripe→Vercel walkthrough.

## V2 — Secure Mode (this branch, not yet released)

Daemon-owned vault key (passphrase + scrypt envelope), one-shot context-bound approval grants through a local web UI, daemon-owned Chrome over `--remote-debugging-pipe`, filtered CDP proxy that blocks screenshots / DOM / AX / Runtime / Console / network-body reads during blind mode, command templates (no arbitrary `use-as-stdin`), exact-by-default domain matching, migration from V0.

## V3 — Stronger Key Storage

- OS keychain (macOS / Windows / Linux Secret Service)
- Signed desktop daemon binary
- Optional hardware-backed unlock (Touch ID / WebAuthn)

## V4 — Platform Helpers

Stripe, Supabase, Clerk, GitHub Actions, Cloudflare, Railway adapters as additional templates and approval flows.

## V5 — Integrations

1Password, Bitwarden, Doppler, Infisical, AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault backends.

## V6 — Team And Commercial

Shared vaults, approval workflows, audit attestations, cloud sync, RBAC, SSO.
