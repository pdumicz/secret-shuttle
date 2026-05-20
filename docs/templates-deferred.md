# Deferred Provider Templates

Secret Shuttle templates ship **only** when the provider's first-party CLI
accepts the secret via true stdin or a `0600` daemon-written env-file. A CLI
that requires the secret as an argv parameter exposes it in the process table
and is unsafe by construction. This document records templates we have
considered and **deferred**, with the specific reason and the gate that would
re-open consideration.

## `github-actions-env-secret-set`

**Why deferred:** GitHub Environment-scoped secrets (`gh secret set <name> --env <env-name> --repo <owner/repo>`) require a per-scope template variant because the argv shape differs from the repo-scoped variant. Phase 4 ships only the repo-scoped template (github-actions-secret-set); mixing the `--env` flag into a single optional-params template would mean the human-approved destination (`destinationEnvironment(params)`) could diverge from the actual argv unless the flag is wired through. The fix-template-scope-args commit (post-Phase-4) chose **rejection** over conditional-args composition for github specifically, because `--env` requires `--repo` while `--org` excludes `--repo` — a single static `args[]` cannot safely express both. A dedicated Environment-scoped template will ship with a fixed argv vector once the per-variant [P2b] gate is verified against current `gh`.

**Re-open gate:** [P2b] verifies `gh secret set --env <env-name> --repo <owner/repo>` works on current `gh` releases (it should — this is documented behavior).

## `github-actions-org-secret-set`

**Why deferred:** GitHub Organization-scoped secrets (`gh secret set <name> --org <org-name> [--visibility ...]`) also require a per-scope template variant. Same rationale as `github-actions-env-secret-set` (mutually-exclusive argv shape vs the repo-scoped default).

**Re-open gate:** [P2b] verifies `gh secret set --org <org-name>` works on current `gh` releases and decides whether the visibility flag (`--visibility all|private|selected`) should be a required-param.

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
