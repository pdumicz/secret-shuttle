# Deferred Provider Templates

Secret Shuttle templates ship **only** when the provider's first-party CLI
accepts the secret via true stdin or a `0600` daemon-written env-file. A CLI
that requires the secret as an argv parameter exposes it in the process table
and is unsafe by construction. This document records templates we have
considered and **deferred**, with the specific reason and the gate that would
re-open consideration.

## `railway-variable-set`

**Why deferred:** the Railway CLI (`railway variables --set KEY=VALUE`) forces
the secret value onto argv. Any process that can read `/proc/<pid>/cmdline`
(or the equivalent on macOS/Windows) sees the secret. This violates the
template requirement that "the **secret value** never appears in argv or env".

**Re-open gate:** Railway adds either true stdin support (e.g.
`railway variables --set KEY --stdin`) or a documented `--env-file` flag.

## `netlify-env-set`

**Why deferred:** the Netlify CLI (`netlify env:set KEY VALUE`) also forces the
secret value onto argv. Same argv-leak failure mode as Railway.

**Re-open gate:** Netlify adds true stdin support or a documented env-file
flag.

## `clerk-env-set`

**Why deferred:** Clerk has no first-party CLI for setting secrets or
environment variables — configuration is via the Clerk dashboard or the
Backend API only. A "template" here would not have a binary to vet; the
Secret Shuttle template contract (binary sha256 in the approval binding,
spawn under daemon control, scrubbed env) does not apply.

**Re-open gate:** Clerk ships a first-party CLI with a secret-setting command
that accepts the value via stdin or env-file.

## Operator notes

For each of the above, the recommended Secret Shuttle workflow today is the
agentic blind transactions browser path — `inject-submit` / `reveal-capture`
against the provider's dashboard, under daemon-owned blind mode and the same
fail-closed absence-proof + auto-resume gates that protect every browser-based
transaction. See [docs/cli-reference.md](./cli-reference.md) and the spec
§4 / §6 / §9 for the trade-off.
