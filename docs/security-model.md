# Security Model

Secret Shuttle V0 is a local-first blind-secret runtime for AI coding-agent workflows.

The V0 security claim is intentionally narrow:

> Secret Shuttle keeps raw secret values local and does not intentionally return them to the AI agent. V0 uses cooperative blind mode; enforced browser observation blocking is planned for later versions.

## Planes

```text
Agent Plane
- navigates browser pages
- reasons about setup
- identifies fields and workflows
- calls CLI commands
- sees refs, fingerprints, labels, domains, and status

Secret Plane
- generates random values
- captures selected text or focused-field values
- encrypts values locally
- injects values into focused fields
- passes values to commands over stdin
- compares values by fingerprint
```

There is no CLI, API, or helper that returns the raw secret value.

## What The Agent Can See

```json
{
  "secret_ref": "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  "name": "STRIPE_WEBHOOK_SECRET",
  "environment": "production",
  "source": "stripe",
  "fingerprint": "sha256:...",
  "value_visible_to_agent": false
}
```

## What The Agent Cannot Ask Secret Shuttle For

- raw secret values
- decrypted vault contents
- `.env` file materialization
- clipboard reads
- screenshots
- DOM dumps

V0 cannot technically prevent a separate browser tool from taking screenshots or reading DOM while the secret is visible. That is why the docs call V0 cooperative blind mode.

## Local Storage

V0 uses an encrypted JSON vault:

```text
~/.secret-shuttle/vault.json.enc
```

The master key is stored in a local restricted-permission file:

```text
~/.secret-shuttle/master-key.json
```

This is enough for an inspectable OSS prototype and prevents accidental raw-value storage in the vault file. It is not equivalent to OS keychain, hardware-backed, or enterprise secret-manager storage.

Future versions should use:

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service
- passphrase-backed vaults
- 1Password, Bitwarden, Doppler, Infisical, AWS Secrets Manager, GCP Secret Manager, or HashiCorp Vault backends

## Browser Control

V0 connects to Chrome over CDP through Playwright Core and supports generic focused-field operations:

- capture selected text
- capture focused input, textarea, or contenteditable text
- inject into focused input, textarea, or contenteditable text
- compare focused value against a stored fingerprint

The browser must be started with remote debugging, for example:

```bash
secret-shuttle browser start --profile prod-config
```

## Production Guardrails

Production injection and production stdin use require explicit approval:

```text
Type PRODUCTION to continue:
```

Non-interactive scripts can pass:

```bash
--confirm-production PRODUCTION
```

The approval output shows:

- secret ref
- destination
- environment
- action
- value visibility status

It never shows the raw value.

## Logs

Audit logs are stored locally at:

```text
~/.secret-shuttle/audit.jsonl
```

Audit events include:

- timestamp
- action
- ref
- domain
- environment
- success status

They do not include raw secret values.

## Honest Limitations

V0 does not protect against:

- malicious local users with filesystem access
- compromised browser extensions
- a malicious destination site receiving a value that the user intentionally injects
- another tool taking a screenshot while cooperative blind mode is active
- another tool reading DOM or accessibility content while cooperative blind mode is active
- commands that intentionally echo stdin, though Secret Shuttle redacts known command output when `--show-output` is used

The next major security step is an enforced CDP proxy that blocks unsafe browser observation calls during blind mode.
