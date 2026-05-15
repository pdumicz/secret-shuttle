# Architecture

Secret Shuttle separates navigation from secret handling.

```text
Claude Code / Codex / Cursor / Browser Agent
        |
        | normal browser navigation
        v
Sensitive page or field
        |
        | stop observing, call CLI
        v
Secret Shuttle CLI
        |
        | policy, vault, approval
        v
Encrypted local vault
        |
        | focused-field capture/injection over CDP
        v
Chrome / SaaS Dashboard
```

## V0 Implementation

V0 is direct CLI first. Commands perform vault, policy, and browser operations in-process.

Main modules:

- `src/cli`: Commander command surface
- `src/vault`: encrypted local vault and metadata-only secret model
- `src/browser`: Playwright Core CDP focused-field adapter
- `src/policy`: blind mode, domains, production approval, action checks
- `src/logging`: local audit events and redaction helpers
- `src/shared`: config paths, refs, errors, JSON output

## Why Not MCP-First

MCP is a useful tool interface, but it is not the security boundary here. The durable product surface is:

- CLI commands agents can call today
- local browser bridge for secret moments
- local vault
- future enforced CDP proxy

An MCP adapter can wrap the same core later without becoming the core security model.

## Future Daemon

The product architecture calls for a localhost daemon. The V0 prototype keeps operations inside the CLI to minimize moving parts. The daemon should become useful once Secret Shuttle owns browser sessions, approval UI, policy state, and CDP proxying.

Planned local API shape:

```http
POST /blind/start
POST /blind/end
POST /secrets/generate
POST /secrets/capture
POST /secrets/inject
POST /secrets/compare
GET  /secrets
```

No local API endpoint should return raw secret values.
