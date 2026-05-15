# Security Model

Secret Shuttle V2 is a local Secure-Mode bridge for AI coding agent workflows.

## Claim

In Secure Mode, the agent can request generation, capture, injection, comparison, and approved template execution, but raw secret values and vault keys never leave the daemon. Browser observation is blocked during blind mode by the Secret Shuttle CDP proxy.

## Two Planes

```text
Agent Plane
- runs the CLI (untrusted client) and a normal browser tool
- sees refs, fingerprints, labels, domains, target ids, field metadata, and status

Secret Plane (daemon)
- owns the unlocked vault key (in memory after passphrase unlock)
- generates secrets, captures values, injects values
- runs vetted command templates
- exposes a filtered CDP WebSocket proxy to the agent
```

There is no daemon endpoint that returns raw secret values.

## Trust Boundary

- The CLI talks to the daemon over HTTP on 127.0.0.1.
- The bearer token lives in `~/.secret-shuttle/daemon-socket.json` (mode 0600).
- The daemon enforces a Host-header allowlist (loopback only).
- The approval UI runs on the daemon and is reached via system-browser open. Each grant gets its own URL-embedded `ui_token`.
- The vault master key is wrapped in `~/.secret-shuttle/key-envelope.json` (scrypt KDF + AES-256-GCM). Decrypted only in daemon memory after `secret-shuttle unlock`.

## Approval Grants

Every production-classed action requires a one-shot grant.
- Daemon-memory only.
- 2-minute TTL.
- Bound to action, ref or planned ref, environment, destination domain, browser target id, focused-field fingerprint, template id, and template params.
- Mismatched, expired, reused, or forged grants are refused.

## Browser Control

- The daemon launches Chrome with `--remote-debugging-pipe`. The raw CDP port is never exposed.
- Agents receive a token-gated WebSocket CDP proxy URL.
- Blind mode is daemon state. While active, the proxy blocks at minimum:
  - `Page.captureScreenshot`, `Page.captureSnapshot`, `Page.printToPDF`
  - `DOM.getDocument`, `DOM.getOuterHTML`, `DOM.getNodeForLocation`, `DOM.performSearch`, `DOM.querySelector*`, `DOM.describeNode`, `DOMSnapshot.*`
  - `Accessibility.*`
  - `Runtime.evaluate`, `Runtime.callFunctionOn`, `Runtime.getProperties`, `Runtime.queryObjects`
  - `Console.*`, `Log.*`
  - `Network.getResponseBody`, `Network.getRequestPostData`, `Network.takeResponseBodyForInterceptionAsStream`, `Fetch.getResponseBody`
- Daemon-internal capture/injection runs narrow scripts directly against Chrome — those calls never traverse the agent proxy.

## Templates

Generic `use-as-stdin --command "..."` is removed. Templates are the only way to hand a secret to an external binary:
- Binary must be an absolute path.
- Binary must not live inside the current workspace.
- Binary must not be world-writable.
- `spawn(binary, args, { shell: false })`.
- Stdout and stderr are suppressed from the agent.
- Result returns only `template_id`, `secret_ref`, `exit_code`, `executed`.

## Domain Matching

Exact by default. Wildcards require `*.example.com`. `vercel.com` does not match `evil-vercel.com` or `dashboard.stripe.com`.

## Local Storage

```text
~/.secret-shuttle/
  config.json
  vault.json.enc
  key-envelope.json    (KDF salt + AES-GCM wrapped master key)
  daemon-socket.json   (port + bearer token + pid)
  state.json           (legacy V0 blind state, unused in Secure Mode)
  audit.jsonl
```

`master-key.json` from V0 is migrated away by `secret-shuttle migrate secure-vault`. The daemon refuses to start while it exists.

## Honest Limitations

Secure Mode protects against:
- Agents reading the vault.
- Agents observing the browser during blind mode through the proxy.
- Agents running arbitrary commands with a secret on stdin.
- Agents bypassing approval with a CLI flag.

Secure Mode does NOT protect against:
- A user with unrestricted same-user shell or process access. The agent must be sandboxed to the Secret Shuttle CLI and CDP proxy surfaces; if it can read process memory, drive arbitrary GUI windows, or open the approval UI on its own, the local guarantee no longer holds.
- A browser extension already installed in the daemon-owned Chrome profile.
- A malicious destination site receiving a secret that the user intentionally injects.
- A compromised kernel.

The next steps to harden Secure Mode are OS-keychain key storage and a signed desktop binary.
