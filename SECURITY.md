# Security

Secret Shuttle's one guarantee: **an AI coding agent can provision, use, and ship secrets without the plaintext ever entering its context.** The agent works with `ss://` refs and fingerprints; a local daemon resolves the real value at the last moment and severs the agent's view during the secret moment.

This file is the honest, plain-English scope. Deeper detail lives in [docs/threat-model.md](docs/threat-model.md) and [docs/security-model.md](docs/security-model.md).

## What it protects against

- **The agent reading the vault.** No daemon endpoint returns a raw secret value. The agent gets refs, fingerprints, and status enums.
- **The agent observing the browser during the secret moment.** Capture/inject run in a daemon-managed blind window; the daemon severs the agent's CDP connection and filters screenshots / DOM / accessibility / console / network-body reads while the secret is on the page.
- **The agent re-reading a secret after the fact.** Before it hands the agent its view back, the daemon runs an **absence proof** and fails closed if it can't confirm the secret is gone (see scope below).
- **Arbitrary command execution with a secret on stdin.** No generic "run this with the secret" — only vetted templates that hand the value to a known vendor CLI on stdin / a `0600` env-file.
- **Brute-forcing a secret from its fingerprint.** Fingerprints are vault-keyed HMAC, not raw hashes; `compare` is approval-gated and rate-limited.
- **Bypassing approval with a flag.** Every production-touching action requires a one-shot, context-bound human approval. There is no override flag.

## What it does NOT protect against (read this before you trust it)

- **A hostile destination page exfiltrating a secret you deliberately entered.** The absence proof scans the page's **DOM and URL** (same-origin, fully-loaded documents) and confirms the secret is no longer visible **to the agent**. It does **not** hook network, clipboard, or storage, and cannot read cross-origin frames — so it cannot prove a page didn't *transmit* a value you chose to type into it. The guarantee is *"the agent never sees the plaintext,"* not *"a malicious vendor page can't leak a secret you gave it."* Only run browser flows against pages you trust; for untrusted destinations, prefer the CLI-template path.
- **A user (or process) with unrestricted same-user shell, process, or GUI access.** The agent must be sandboxed to the Secret Shuttle CLI and CDP proxy. Anything that can read the daemon's process memory, drive arbitrary GUI windows, or open the approval UI itself defeats the local guarantee.
- **A malicious browser extension already installed in the daemon-owned Chrome profile.**
- **A compromised OS / kernel.**

## Maturity

**0.5.0 — beta.** The design has been through multiple rounds of adversarial security review with fixes shipped at each gate. It is **not yet independently audited** — use test accounts and rotating tokens until that audit lands.

The **CLI-template path** (Vercel / GitHub Actions / Cloudflare / Supabase) is the most reliable — it never touches a live page. The **browser-handoff path** (`reveal-capture` / `inject-submit` on an arbitrary portal) is **best-effort and pending real-page verification**; the blind machinery has route + unit coverage but is not yet certified end-to-end against real logged-in dashboards.

## Reporting a vulnerability

Please report privately, not in a public issue. Use **GitHub's private security advisories** on this repository (Security tab → "Report a vulnerability"). Include repro steps and the affected version. I'll acknowledge and work a fix before any public disclosure.
