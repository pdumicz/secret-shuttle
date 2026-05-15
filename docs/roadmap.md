# Roadmap

## V0: OSS Prototype

- CLI
- encrypted local vault
- secret refs
- generate
- focused-field capture
- selected-text capture
- focused-field injection
- fingerprint comparison
- cooperative blind mode
- production approval prompt
- stdin handoff
- Claude Skill and generic agent instructions
- Stripe to Vercel walkthrough

## V1: Better Browser Runtime

- Secret Shuttle-owned browser sessions
- better active-tab selection
- stronger focused-field detection
- local approval UI
- clearer action receipts
- more robust Browser Harness docs

## V2: Enforced Blind Mode

- CDP proxy
- block screenshots during blind mode
- block DOM tree extraction during blind mode
- block accessibility tree extraction during blind mode
- restrict unsafe `Runtime.evaluate`
- block console and network-body reads
- redact known secret patterns at protocol boundaries

## V3: Platform Workflows

- Vercel env workflow helper
- Stripe webhook helper
- Supabase secret helper
- Clerk key helper
- GitHub Actions secrets helper
- Cloudflare Workers secret helper
- Railway variables helper

## V4: Integrations

- 1Password
- Bitwarden
- Doppler
- Infisical
- AWS Secrets Manager
- GCP Secret Manager
- HashiCorp Vault

## V5: Team And Commercial

- team policies
- shared vaults
- production approval workflows
- audit logs and action receipts
- cloud sync
- RBAC
- SSO
- compliance reports
