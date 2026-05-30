# Secret Shuttle — Honesty Pass (demo + README) — Design

**Date:** 2026-05-30
**Status:** Design (awaiting user review)
**Scope:** Documentation/demo truthfulness only. No runtime/CLI behavior changes.

## Problem

The demo (`demo/index.html`) and the README drifted from the shipped v0.4.0 CLI.
Concretely:

- The demo invokes commands that were **removed in v0.3.0**: `secret-shuttle doctor`
  (now `status`) and `secret-shuttle generate` (now `secrets set --kind ...` or
  `provision --secret`). A viewer copying the demo would hit "unknown command".
- The demo's "magic path" (Scene 0) narrates a **3-step** provision
  (`provision --infer` → bare `provision` → `provision --continue`), but the real
  flow is **2 steps**: `provision --infer` writes the yml *and* returns
  `approval_required` in one call; then `provision --continue` ships. The middle
  bare-`provision` step does not exist in the canonical flow.
- The demo's install (Scene 3) shows the removed
  `npm install -g … && daemon start && unlock` ritual instead of the shipped
  `npx secret-shuttle init`.
- The demo's absence-proof claim (Scenes 7/8) says the daemon proves the value is
  absent from "every observable surface". Today the proof is a **synchronous DOM
  scan** — it does not yet hook non-DOM exfil sinks (postMessage, sendBeacon,
  fetch/XHR bodies, title, cookie). The claim over-promises relative to the
  current implementation. (Spec B / item 4 closes that gap and lets us
  re-strengthen the wording.)
- The README's "What Works Today" omits shipped verbs (OS-keychain storage,
  `secrets rotate`, `import`, `secrets delete`), and its "What Does Not Work Yet"
  still lists OS-keychain and rotation/import as *not working* — both ship in
  0.4.0. The README's install line also over-promises a Touch ID prompt on
  first run (first run is passphrase-in-window; Touch ID is for later unlocks).

**Root cause of the drift:** the existing drift-guard test
(`src/e2e/docs-no-removed-verbs.test.ts`) scans `SKILL.md`, `agents/*.example.md`,
the walkthrough, and `README.md` — but **not** `demo/index.html`. That is exactly
why the dead `doctor`/`generate` survived in the demo while the other surfaces
stayed clean.

## Goal

Make the demo and README tell the truth about v0.4.0 — no dead commands, the real
2-step magic path, an install line that matches `init`, an absence-proof claim
honest to the current DOM-scan implementation — and add a regression guard so the
demo cannot silently drift again.

## Non-goals (YAGNI)

- No demo restructure, renumber, or new scenes. Edits are in-place to existing
  scene copy/stages.
- No flow-freshness assertion that the demo's narrated steps match the SKILL
  quickstart (brittle for a hand-authored storyboard; explicitly rejected during
  brainstorming).
- No README rewrite beyond the truthfulness deltas below.
- No changes to CLI behavior, daemon, or absence-proof implementation. (The
  absence-proof *wording* softens here; the *implementation* strengthening is
  Spec B / item 4.)

## Design

### Part 1 — Demo fixes (`demo/index.html`)

All changes are to existing scene copy and the in-stage terminal text. Scene
numbering is unchanged (Scene 0 + Scenes 1–9).

| Scene | Change | Rationale |
|---|---|---|
| 0 (Magic path) | Collapse the narrated 3-step provision to the real 2 steps: `provision --infer` (writes yml **and** returns `approval_required`) → click Approve once → `provision --continue --batch <id> --approval-id <id>`. Remove the standalone bare-`provision` step from the copy. | `provision --infer` already plans in one call (`src/cli/commands/provision.ts` runYmlMode); SKILL.md quickstart is the 2-step canonical. |
| 3 (Install) | Replace `npm install -g secret-shuttle` + `secret-shuttle daemon start` + `secret-shuttle unlock` with a single `npx secret-shuttle init`. Keep the passphrase-window visual (accurate first-run moment). | `init` subsumes daemon start + vault create/unlock + keychain enroll + agent-skill install. |
| 4 (Agent setup) | Reframe from "run `agent install claude`" to "`init` already wrote the skill; add codex/cursor/copilot with `secret-shuttle agent install <target>`." Swap "doctor first" → "status first." | `init` auto-installs the skill for detected runtimes; `doctor` is removed. |
| 5 (Generate + push) | Keep the two-approval narrative. Swap dead commands only, preserving the existing non-dead policy flags: `doctor --json` → `status --json`; `generate --name … --kind random_32_bytes --allow-domain … --allow-action …` → `secrets set --name INTERNAL_CRON_SECRET --env production --kind random_32_bytes --allow-domain vercel.com --allow-action use_as_stdin`. | `secrets set --kind` is the `generate` replacement (`src/cli/commands/secrets/set.ts`). The `--allow-domain` flag must be kept: `secrets set` rejects production secrets with zero `--allow-domain` (`set.ts:35-40` throws `missing_allow_domain`), so a copied command without it would still fail. Two-approval story is unchanged by the swap. |
| 7 / 8 (Absence proof) | Soften "proves the value is absent from **every observable surface**" → "every surface the daemon can observe in the DOM." | Honest to today's synchronous DOM scan. Re-strengthened after Spec B (item 4) ships CDP sink hooks. |
| 9 (Recap) | `Doctor reports` → `status reports`; `secret-shuttle doctor` → `secret-shuttle status`. | `doctor` is removed. |

**Acceptance for Part 1:** every `secret-shuttle <verb>` rendered in the demo
resolves to a registered command; the magic path reads as 2 steps; install reads
as `npx secret-shuttle init`; the absence-proof claim is DOM-scoped.

### Part 2 — README fixes (`README.md`)

- **"30-Second Install"** — fix the Touch ID over-promise. First run creates the
  passphrase in a local window; Touch ID is not a first-run prompt but how
  *subsequent* unlocks work once the keychain is enrolled. `init` enrols the
  keychain by default when it creates the vault (`--no-keychain` opts out;
  `keychain enable` does it later), so the wording must not imply enrollment is a
  separate manual step. (Wording, not a list change.)
- **"What Works Today (0.4.0)"** — add the shipped-but-unlisted verbs:
  - OS-keychain key storage (`keychain enable|disable|status`).
  - `secrets rotate` — generates a new ref and marks the old one `rotating`;
    caller re-pushes then deletes the old. Phrase honestly: it does **not** yet
    auto-re-push to existing bindings (confirmed in `secrets/rotate.ts:9`,
    `:48`).
  - `import` — import secrets from a `.env` file into the vault.
  - `secrets delete <ref>`.
- **"What Does Not Work Yet"**:
  - Remove "OS-keychain or hardware-backed key storage" (keychain ships; note
    hardware-backed/HSM is still out if that distinction matters).
  - Narrow "Secret rotation / import / export workflows" → "Secret **export**
    workflows" (rotate + import ship; export does not).

**Acceptance for Part 2:** the listed shipped/not-working claims are accurate for
the commands mentioned here (the keychain, `secrets rotate`, `import`, and
`secrets delete` deltas above); none of those shipped verbs is listed as
not-working; rotate is described without implying auto-re-push; install line
distinguishes first-run passphrase from later Touch ID. (This is the scoped set of
truthfulness deltas, not a full reconciliation of the README against the entire
command set — per the "no README rewrite beyond truthfulness deltas" non-goal.)

### Part 3 — Regression guard (`src/e2e/docs-no-removed-verbs.test.ts`)

Extend the existing drift-guard so it also covers the demo. Three complementary
checks:

1. **Reuse the existing token scan on the demo.** Add `demo/index.html` to the
   `DOCS` list so the current `REMOVED_TOKENS` / `MOVED_TOKENS` regexes (which
   already catch bare `generate`, `bootstrap`, `capture`, `blind`, `compare`, and
   the `daemon start && …` ritual) now also fire on the demo. This alone would
   have caught `generate`.

2. **Add a registry-backed command-path assertion for the demo.** `doctor` is not
   in the removed/moved token lists (it was removed earlier, in v0.3.0), so the
   token scan would miss it. Add a check that extracts every `secret-shuttle …`
   invocation from `demo/index.html` and asserts that each one resolves to a
   **registered command path** (not merely a registered top-level verb — see the
   command-path note below). Source the allowed set from the command registry (not
   a hardcoded list) so newly added commands are covered automatically and removed
   commands fail the test. Hyphenated and `internal`-namespaced verbs
   (`inject-submit`, `reveal-capture`, `internal …`) are themselves registered
   commands and **must validate, not be skipped** — the extractor tokenizes them
   normally and resolves them through the registry like any other command.

**Design note — side-effect-free registry access is a prerequisite.** The CLI
entrypoint (`src/cli/index.ts`) builds and configures `program` at module
top-level, so importing it from the test would risk executing parse/help/version
behavior under the runner. Before this guard can read the registry, factor the
command construction into a side-effect-free `buildProgram()` (or an exported
command-registry helper) that returns the configured `Command` tree **without**
calling `parse`/`parseAsync` or emitting output. The CLI entrypoint and the drift
guard then both consume that single factory. (This is the only source change in
this otherwise docs-only spec; it is mechanical extraction, not behavior change.)

**Design note — validate the full command path, not just the first token.** A
top-level-token-only check passes invalid copy-paste like `secret-shuttle secrets
generate` or `secret-shuttle agent setup claude`, because `secrets` and `agent`
are valid top-level commands while `generate`/`setup claude` are not. The guard
must instead resolve the **longest matching command path** through the Commander
tree (walking subcommands until it hits an option/argument token, i.e. a token
starting with `-` or one that no longer matches a registered subcommand). The
invocation is valid only if the consumed prefix resolves to a real command/leaf.
Once the walk stops at the resolved leaf command, the guard recognizes the
remaining tokens by inspecting that command's Commander metadata, tightly enough
to actually catch drift (a permissive "any option-looking token + any trailing
token when the command has ≥1 positional" rule would silently pass invalid copy):
- **Option tokens** (starting with `-`) are validated by name against the resolved
  command's registered options (long/short). `--help`/`-h` are always allowed, and
  any option is accepted when the command opts into `allowUnknownOption()` (e.g.
  the `bootstrap` stub). A value-bearing option (`--flag <value>`) consumes the
  following token as its value so the value is not miscounted as a positional.
- **Trailing non-option tokens** are checked against the resolved command's
  declared positional **arity** (`registeredArguments`): a command with N
  non-variadic positionals accepts at most N, a variadic positional soaks up the
  rest, and a command with zero positionals accepts none. So `agent install
  claude`, `template run vercel-env-add`, and `secrets delete ss://...` pass (one
  declared positional, one supplied), while an extra positional or an unknown
  option fails.
- **`help <command…>` is special**: its variadic `[command...]` positional is
  itself a command path, so the trailing tokens are re-resolved as a path from the
  program root rather than waved through as positional values. This stops a removed
  verb laundered through `help` (e.g. `secret-shuttle help doctor`) from silently
  passing.
A trailing token that is a valid argument for the resolved command keeps the path
valid; only a token that is neither a known subcommand, a registered option, nor
an accepted positional (within arity) means the command path is invalid and the
test fails. Negative coverage must include at least: extra positionals
(`status extra-arg`), an unknown option, and a stale command name passed through
`help`.

**Design note — why registry-backed, not a hardcoded list:** a hardcoded allow
list is itself a drift surface (it goes stale on the next rename). Reading the
registered command tree via `buildProgram()` keeps the guard self-maintaining.
The goal is a single source of truth, not a second hand-maintained list.

3. **Add a Scene 3 install-shape assertion.** Neither check above prevents the
   removed install ritual from creeping back into Scene 3: the `secret-shuttle
   daemon start` and `secret-shuttle unlock` commands are still *registered* (so
   the registry check passes them), and `npm install -g secret-shuttle` is not a
   `secret-shuttle <verb>` form at all (so the registry check never sees it). Add a
   scene-specific check that asserts Scene 3's install copy uses `npx
   secret-shuttle init` and does **not** contain the old `npm install -g
   secret-shuttle` / `secret-shuttle daemon start` / `secret-shuttle unlock`
   install sequence. Scope the forbidden patterns to the **CLI command** strings
   (e.g. `secret-shuttle unlock`), and only within Scene 3's stage text, so that
   passphrase-window copy like "Create & unlock" and legitimate uses of the words
   `daemon`/`unlock` elsewhere in the demo are unaffected.

**Acceptance for Part 3:** the extended test fails if the demo references a
removed/moved verb, any `secret-shuttle …` invocation whose full command path is
not registered (e.g. `secrets generate`, `agent setup claude`), an invocation with
an unknown option or an extra positional beyond the resolved command's arity, a
removed verb laundered through `help` (e.g. `help doctor`), or the removed Scene 3
install ritual (`npm install -g secret-shuttle` / `secret-shuttle daemon start` /
`secret-shuttle unlock`); it passes on the corrected demo, including Scene 3's
retained passphrase-window copy "Create & unlock". The resolver's negative
coverage explicitly includes extra positionals, an unknown option, and a stale
command name via `help`. The registry it validates against is sourced from a
side-effect-free `buildProgram()` shared with the CLI entrypoint.

## Risks / edge cases

- **Command extraction false positives.** The demo prose contains
  `secret-shuttle` in narrative sentences, not only fenced commands. The extractor
  must match the `secret-shuttle …` shape conservatively (tokens = subsequent
  words that look like command/option/argument tokens) and tolerate prose. It then
  resolves the longest registered command path (per the Part 3 command-path note)
  and validates the remaining tokens against the leaf command's option/positional
  metadata; subcommand forms like `secrets set`, `template run`, `browser mark` are
  validated all the way to the leaf, not just on their first token — which is what
  catches invalid pairings like `secrets generate` or `agent setup claude`, an
  unknown option, an extra positional, or a removed verb passed through `help`.
- **`internal`-namespaced and hyphenated verbs.** `secret-shuttle internal …`,
  `secret-shuttle inject-submit`, and `secret-shuttle reveal-capture` are all
  registered commands and must **pass** (validated through the registry, not
  excluded). The extractor tokenizes hyphenated command names normally and the
  registry includes hidden/internal commands so they resolve. The existing
  MOVED_TOKENS adjacency continues to handle the bare `capture`/`blind`/`compare`
  case from the token scan in check 1.
- **Absence-proof wording coupling.** The softened Scenes 7/8 wording is
  intentionally weaker than the eventual goal. Spec B (item 4) must re-strengthen
  this wording as part of its acceptance, so the two specs stay coordinated. Noted
  here so the weaker claim is not mistaken for the final state.

## Testing

- Run the extended `src/e2e/docs-no-removed-verbs.test.ts` — must pass on the
  corrected demo and fail on a deliberately reintroduced `doctor`/`generate`, an
  invalid command path (`secrets generate`, `agent setup claude`), or the old
  Scene 3 install ritual (`npm install -g secret-shuttle` / `secret-shuttle daemon
  start` / `secret-shuttle unlock`). It must still pass with Scene 3's retained
  "Create & unlock" passphrase-window copy present.
- Add/extend a unit test for the extracted `buildProgram()` confirming it returns
  the configured command tree without parsing argv or emitting output.
- Existing doc drift-guards continue to pass on `README.md`, `SKILL.md`,
  `agents/*.example.md`, walkthrough.
- Manual: open the demo (`demo/index.html`, `?scene=0` … `?scene=9`) and confirm
  each scene's rendered commands match the corrected copy.

## Out of scope / follow-ups

- Spec B (item 4): CDP sink hooks for the absence proof → then re-strengthen the
  Scenes 7/8 wording back to "every surface the daemon can observe".
- Spec C (item 5): onboarding (discovery + mid-session reload).
- Item 3 ([P2a] real-page gates): explanation delivered; strategic decision still
  the user's to make.
