# Threat Model

## Assets

- production API keys
- webhook signing secrets
- service-role keys
- generated internal secrets
- production env var values
- local encrypted vault
- local master key

## Trusted Components In V0

- the local Secret Shuttle CLI process
- the local filesystem permissions protecting `~/.secret-shuttle`
- the Chrome instance reached over local CDP
- the user approving production operations

## Untrusted Or Partially Trusted Components

- AI coding agents
- browser pages
- SaaS dashboards
- shell commands invoked through `use-as-stdin`
- logs from external tools
- screenshots, DOM observations, and accessibility-tree observations from browser automation tools

## Threats And Mitigations

### Agent asks to read a secret

Mitigation:

- no raw-value read command exists
- list and inspect return metadata only
- local API should keep the same rule when implemented

### Agent takes a screenshot while a secret is visible

V0 mitigation:

- cooperative blind mode instructions
- agent guidance tells the agent to stop observing

Future mitigation:

- CDP proxy blocks `Page.captureScreenshot` during blind mode

### Agent inspects DOM or accessibility tree while a secret is visible

V0 mitigation:

- cooperative blind mode instructions

Future mitigation:

- CDP proxy blocks or sanitizes DOM, AX tree, console, runtime, clipboard, and network-body reads

### Secret leaks through CLI output

Mitigation:

- Secret Shuttle never prints raw secret values
- command success payloads include refs and fingerprints only
- `use-as-stdin --show-output` redacts known exact values and common secret patterns

Residual risk:

- external commands may write secrets somewhere else
- commands may encode or transform secrets before printing them

### Secret is injected into the wrong domain

Mitigation:

- each secret stores allowed domains
- injection checks the current browser domain
- optional `--domain` must match current browser domain
- production operations require approval

### Secret is captured from the wrong field

Mitigation:

- V0 captures only selected text or the currently focused editable field
- output includes non-secret field metadata
- user/agent workflow should stop observation and focus the exact field before capture

Future mitigation:

- local approval UI with field context
- platform-specific helpers for high-value flows

### Local malware reads the vault

Mitigation:

- vault contents are encrypted at rest
- vault and key files are written with restricted permissions where supported

Residual risk:

- V0 local-file key storage is not a defense against local malware or a user with full filesystem access

### Malicious website reads an injected secret

Mitigation:

- domain allowlists
- production approval

Residual risk:

- if the user intentionally injects a secret into a website, that website receives the value

## Non-Goals For V0

- enterprise compliance
- SSO or RBAC
- root-user defense
- malicious kernel defense
- cloud sync
- browser extension isolation
- enforced browser observation blocking
