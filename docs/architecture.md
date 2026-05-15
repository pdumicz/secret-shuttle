# Architecture

Secret Shuttle separates navigation from secret handling, and pushes the trust boundary into a local daemon.

```text
Claude Code / Codex / Cursor / Browser Agent
        |
        | normal browser navigation through the Secret Shuttle CDP proxy
        v
Sensitive page or field
        |
        | stop observing; call the CLI; the CLI calls the daemon
        v
Secret Shuttle CLI (untrusted client)
        |
        | HTTP 127.0.0.1 + bearer token
        v
Secret Shuttle daemon
  - policy (exact domains, approval grants, blind mode)
  - vault (unlocked key in memory)
  - CDP proxy that filters observation methods during blind mode
  - template runner (no shell, absolute paths only)
        |
        | raw CDP over pipe
        v
Chrome / SaaS dashboard
```

## Modules

- `src/cli` — Commander surface; every command is an HTTP client to the daemon.
- `src/client` — daemon-client.ts: bearer-authenticated `fetch` wrapper that reads the socket file.
- `src/daemon` — daemon process entry, HTTP server, routes, service container.
- `src/daemon/approvals` — grant store, UI server, openUrl helper, requireApproval helper.
- `src/daemon/chrome` — pipe transport, raw CDP client, Chrome launcher, internal capture/inject ops.
- `src/daemon/proxy` — WebSocket CDP proxy + blind-mode method filter.
- `src/daemon/templates` — registry, built-in `vercel-env-add`, safe runner, resolve-binary.
- `src/policy` — domain matching (exact + wildcard) and action whitelists.
- `src/vault` — locked-state container, scrypt envelope, vault crypto, fingerprints.

## Local API Shape

```http
POST /v1/unlock/start
POST /v1/unlock/poll
GET  /v1/status
POST /v1/lock
POST /v1/blind/start
POST /v1/blind/end
POST /v1/secrets/list
POST /v1/secrets/inspect
POST /v1/secrets/generate
POST /v1/secrets/capture
POST /v1/secrets/inject
POST /v1/secrets/compare
POST /v1/approvals/poll
POST /v1/browser/start
POST /v1/templates/list
POST /v1/templates/run
```

No endpoint returns raw secret values.
