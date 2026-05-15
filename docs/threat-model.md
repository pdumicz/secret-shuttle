# Threat Model

## Assets

- Production API keys, webhook signing secrets, service-role keys, generated internal secrets
- Local encrypted vault
- Vault master key (in daemon memory only after unlock)
- Approval grants

## Trust Surface

- The Secret Shuttle daemon process
- The local filesystem permissions protecting `~/.secret-shuttle`
- The Chrome instance launched by the daemon over `--remote-debugging-pipe`
- The user approving production operations through the local web UI

## Untrusted Or Partially Trusted

- AI coding agents
- Browser pages
- SaaS dashboards
- Command templates (vetted; cannot be supplied by the agent at runtime)
- Logs from external tools
- Screenshots, DOM observations, accessibility-tree observations from browser automation tools

## Threats And Mitigations

### Agent asks the daemon to return a raw secret

There is no daemon endpoint that returns raw secret values. `list` and `inspect` return metadata only.

### Agent takes a screenshot while a secret is visible

Blind mode is daemon state. The agent reaches Chrome only through the filtered CDP proxy. While blind mode is active, `Page.captureScreenshot`, `Page.captureSnapshot`, and `Page.printToPDF` are rejected at the proxy.

### Agent inspects DOM, AX tree, console, runtime, or network bodies

The CDP proxy blocks the corresponding methods during blind mode. The daemon's own internal capture/injection scripts bypass the proxy.

### Secret is injected into the wrong domain

Each secret stores allowed domains (exact match by default; `*.example.com` for wildcards). The daemon checks the current page domain before injecting. Production actions also require a grant bound to the exact domain.

### Secret is captured from the wrong field

The daemon takes a focused-field fingerprint snapshot before approval and re-checks the same fingerprint immediately before capture or injection. Field changes after approval throw `field_changed`.

### Local malware reads the vault

The vault is AES-256-GCM encrypted with a master key wrapped in a scrypt-derived KEK. The master key only exists in daemon memory while unlocked. An attacker who can read the daemon's memory wins; protect the host accordingly.

### Agent bypasses approval with a CLI flag

There is no such flag in Secure Mode. `--confirm-production` is removed. Approval is daemon-issued and bound to the exact action context.

### Agent runs `use-as-stdin --command "rm -rf /"`

`use-as-stdin` returns `removed_in_secure_mode`. The replacement (`template run`) only accepts a fixed registry id, runs an absolute non-workspace binary, uses `shell: false`, and suppresses stdout/stderr from the agent.

### Agent receives the raw CDP URL

It does not. `secret-shuttle browser start` returns the proxy URL only.

## Non-Goals

- Defense against a user with unrestricted same-user shell, process, or GUI access. Secure Mode assumes the agent is sandboxed to the Secret Shuttle CLI and CDP proxy.
- Compromised kernel.
- Browser extension already trusted in the daemon-owned profile.
- Enterprise compliance — SSO, RBAC, audit attestations.
