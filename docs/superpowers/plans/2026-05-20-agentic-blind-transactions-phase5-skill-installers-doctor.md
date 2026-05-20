# Phase 5 — Agent Skill + Installers + doctor/health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the canonical agent SKILL.md (`skills/secret-shuttle/SKILL.md`), cross-agent installers (`secret-shuttle agent install claude|codex|cursor|copilot` + `agent print-skill-url`) with idempotent snippet-marker writes and full-file writes, extend `GET /v1/health` with an `agentic_browser` capability block (`available`, `browser_started`, `proxy_active`, `handles_supported`, `marks_active`), and extend the `doctor` CLI (text + `--json`) with an `agentic flows: available|unavailable (start browser)` line derived from that block. Retire the old `skills/claude-code/SKILL.md` (delete the file + its `package.json` `files` entry) in favor of the new canonical path.

**Architecture:** Pure additive feature surface — no Phase-2/3/4 invariants touched. New: `skills/secret-shuttle/SKILL.md` as source of truth (read at runtime by the installers from the package's own bundled copy); a new `agent` Commander subcommand group (`install <target>` + `print-skill-url`); a marker-based snippet writer (`<!-- secret-shuttle:begin --> … <!-- secret-shuttle:end -->`) + a wholesale full-file writer (atomic via temp+rename); a `derive-skill-url` helper that reads `package.json` `repository.url` and transforms `github.com/<owner>/<repo>.git` → `raw.githubusercontent.com/<owner>/<repo>/<branch>/skills/secret-shuttle/SKILL.md` (default `main`, `--branch`/`--ref` override); a `repository` field added to `package.json`; a `README.md` "paste this URL into your agent" line; the existing `/v1/health` route gains an `agentic_browser` object derived from `services.browser !== null && services.cdpProxy !== null && services.handles.list().length`-style counts; the `doctor` command gains one line per the spec. Spec: [docs/superpowers/specs/2026-05-18-agentic-blind-transactions-design.md](../specs/2026-05-18-agentic-blind-transactions-design.md) §10 + §11 + §14 phase-5 row + §15 acceptance (signed off at commit `d1c89ed`); Phases 1–4 merged on `main` (current tip `81905ee`, tag `phase4-templates-complete`).

**Tech Stack:** Same as Phase 2/3/4 — TypeScript (ESM, NodeNext, `.js` import specifiers, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Commander CLI, Node built-in `http` daemon, raw CDP over a pipe transport, `node:test` + `node:assert/strict` (tests build to `dist/` then run via `node --test`).

---

## Scope: this plan covers Phase 5 only

The spec (§14) defines five independently shippable phases. Phases 1 (Opaque Browser Handles), 2 (`inject-submit`), 3 (`reveal-capture`), and 4 (Provider Templates) are **merged** on `main`. **This document is the complete, executable plan for Phase 5 (Agent Skill + Installers + doctor/health)** — spec §10.1 (canonical skill content + retire `skills/claude-code/SKILL.md`), §10.2 (installers with marker-based snippet writes vs wholesale full-file writes, `print-skill-url` derived from `package.json` `repository`, README update), §11 (`/v1/health.agentic_browser` block + `doctor` agentic-flows line), §14 phase-5 row (per-provider production-vs-best-effort statement from the Phase-2/3 [P2a] + Phase-4 [P2b] outcomes), and §15 acceptance (the skill file is enough for Claude/Copilot/Codex without docs; `doctor` reports browser-flow availability).

**Out of this plan:** there is no future plan — Phase 5 closes the design.

**Per-provider source-of-truth note (§14 + §15):** the skill file (§10.1) and the README (§10.2) must state, per provider, whether the browser flow is **production** or **best-effort (template-primary)** based on the upstream [P2a]/[P2b] gate outcomes:

- **Phase-2 [P2a] Vercel real-page gate** → recorded in `docs/superpowers/plans/2026-05-18-agentic-blind-transactions-phase2-inject-submit.md`'s "## [P2a] Gate outcome" section (currently **PENDING** — empty placeholder text).
- **Phase-3 [P2a] Stripe real-page gate** → recorded in `docs/superpowers/plans/2026-05-19-agentic-blind-transactions-phase3-reveal-capture.md`'s "## [P2a] Gate outcome" section (currently **USER-DEFERRED**, see task #5 in the active task list).
- **Phase-4 [P2b] template `--help` gate** → recorded in `docs/superpowers/plans/2026-05-20-agentic-blind-transactions-phase4-templates.md`'s "## [P2b] Gate outcome" section (currently **PENDING** — empty placeholder text).

Because all three gates are currently PENDING/DEFERRED, the **honest** skill + README copy is:

> "Browser flow status (P2a/P2b real-page gates): **PENDING**. Treat all browser flows (Vercel `inject-submit`, Stripe `reveal-capture`) as best-effort until the upstream Phase-2/3 [P2a] gate outcomes are recorded in their respective plan files. Prefer `template run` for `vercel-env-add`, `github-actions-secret-set`, `cloudflare-secret-put`, and `supabase-edge-secret-set` (Phase-4 templates, [P2b] gate PENDING — verify `--help` argv against current CLI versions before each release)."

This statement is the source-of-truth copy that lives in `skills/secret-shuttle/SKILL.md` + `README.md`; when any of the three gates flips PASS or BEST-EFFORT in its plan file, a follow-up commit edits the skill + README to match. This plan does **not** attempt to forecast gate outcomes — it states the current PENDING reality.

**Carried residual:** Phase 5 has **no manual release gate of its own** (unlike Phases 2/3/4). The skill's per-provider statement is correct-by-construction because it transcribes the gate-outcome text from the upstream plan files; if those files are still PENDING, the skill says PENDING (this is the security/honesty invariant — never misrepresent provider status).

---

## Phase 5 File Structure

- **Create** `skills/secret-shuttle/SKILL.md` — the canonical agent-facing operating manual (spec §10.1's seven directives + the `mark pick` concurrent-control choreography + concurrent-control fallback + the "what NOT to do during blind mode" block + the per-provider production-vs-best-effort statement derived from the PENDING gate outcomes per the note above). Read directly by the installers at install time.
- **Delete** `skills/claude-code/SKILL.md` — retired; replaced by the canonical path. The git history preserves it. `package.json`'s `files` array is updated to drop `skills` (it currently ships the whole `skills/` directory) and re-add `skills/secret-shuttle/SKILL.md` explicitly so the new canonical path is shipped and the deleted directory stays gone if anyone restores it locally without updating `files`.
- **Modify** `package.json` — (a) replace `"skills"` entry in `files` with `"skills/secret-shuttle/SKILL.md"`; (b) add `"repository": { "type": "git", "url": "https://github.com/pdumicz/secret-shuttle.git" }` (top-level, alphabetical-ish, between `"description"` and `"type"`); (c) leave `version`, scripts, and deps untouched.
- **Create** `src/cli/skill-url.ts` — pure helper. Exports `deriveSkillUrl(pkg: { repository?: { url?: string } | string }, opts?: { branch?: string; path?: string }): string`. Transforms `https://github.com/<owner>/<repo>.git` (or `git+https://…`, or shorthand `github:owner/repo`) → `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` with `branch` defaulting to `"main"` and `path` defaulting to `"skills/secret-shuttle/SKILL.md"`. Throws a `ShuttleError("repository_field_missing", …)` if `pkg.repository.url` is absent or unparseable. Pure, no I/O.
- **Create** `src/cli/skill-url.test.ts` — `deriveSkillUrl` tests: github HTTPS url, `git+https://` prefix, `.git` suffix, no `.git` suffix, shorthand `github:owner/repo`, `--branch`/`--ref` override, missing repository field throws, non-github host throws.
- **Create** `src/cli/agent-writer.ts` — pure I/O helpers. Exports `writeAgentFile({ targetPath, content }: { targetPath: string; content: string }): Promise<void>` (wholesale overwrite, atomic via `O_CREAT|O_TRUNC` then rename, mkdir-p parent dir, sets file mode `0644`) and `writeAgentSnippet({ targetPath, content, beginMarker, endMarker }: { targetPath: string; content: string; beginMarker: string; endMarker: string }): Promise<void>` (idempotent marker-based snippet writer: (i) if file does not exist → create with `beginMarker + "\n" + content + "\n" + endMarker + "\n"`; (ii) if file exists and contains both markers → replace the byte range between them (inclusive of the marker lines themselves) with the new marked block, preserving every other byte; (iii) if file exists and lacks one or both markers → append two leading newlines + the new marked block at end-of-file, preserving every other byte). Uses atomic temp+rename. Both helpers mkdir-p their parent directory if missing. No symlink-following — if `targetPath` is a symlink the temp-rename replaces the symlink with a regular file (intentional; agents must not write through symlinks to surprise destinations).
- **Create** `src/cli/agent-writer.test.ts` — `writeAgentFile` tests: creates a new file with the exact content + `0644` mode + creates the parent dir if missing + overwrites an existing file wholesale (a sentinel byte at the start of an existing file is gone after the write). `writeAgentSnippet` tests: round-trip (initial write writes a fresh marked block; second run with different content replaces only the marked range and preserves a sentinel line before the begin marker + a sentinel line after the end marker); existing file with NO markers — the new block is appended at end, preserving every preexisting byte; missing target file — created with just the marked block + a single trailing newline; existing file with the begin marker but no end marker — treated as "lacks markers", new block appended (the malformed first marker stays in place; the executor must not attempt repair); existing file with both markers but content already matches new content — a no-op observable (file bytes unchanged); parent-dir-creation case (target is `nested/sub/AGENTS.md`).
- **Create** `src/cli/commands/agent.ts` — the `agent` Commander subcommand group: `install <target>` (where `target ∈ {claude, codex, cursor, copilot}`) and `print-skill-url`. The command reads the bundled `skills/secret-shuttle/SKILL.md` from the package install location (resolved via `import.meta.url` then `path.resolve(...)` to walk up from `dist/cli/commands/agent.js` → `dist/../../skills/secret-shuttle/SKILL.md` — i.e. the package's own `skills/` directory shipped via `package.json` `files`). Writes operate on `process.cwd()`. Per-target destinations and write modes (per spec §10.2):
  - `claude` → `.claude/skills/secret-shuttle/SKILL.md` — **wholesale full-file write** (owned by secret-shuttle).
  - `codex` → `AGENTS.md` — **marker snippet write** with `<!-- secret-shuttle:begin -->` / `<!-- secret-shuttle:end -->`.
  - `cursor` → `.cursor/rules/secret-shuttle.mdc` — **wholesale full-file write** (owned by secret-shuttle; `.mdc` extension is Cursor's rules format which is a Markdown superset, so the SKILL.md body is copied verbatim).
  - `copilot` → `.github/copilot-instructions.md` — **marker snippet write** with the same markers as codex.
  - `print-skill-url` prints the URL derived via `deriveSkillUrl(packageJson, { branch })`. `--branch <name>` / `--ref <name>` flags override the default `main`. Exactly one URL line on stdout (no JSON wrapper) — the spec calls this a "one line paste" command and the convention is plain text (the existing `outputJson(ok(...))` convention is for structured RPC responses, not human-paste output).
- **Create** `src/cli/commands/agent.test.ts` — `agent install` integration tests: writes to a tmp dir set as CWD via `process.chdir`, verifies the destination file exists at the spec'd path with the spec'd content; second run is idempotent (snippet targets) or wholesale-overwrite (full-file targets); `agent install codex` followed by `agent install codex` produces exactly one marked block; `agent install codex` against a pre-existing `AGENTS.md` with non-secret-shuttle content preserves that content; `agent install claude` writes to `.claude/skills/secret-shuttle/SKILL.md`; `print-skill-url` prints the derived URL with `--branch feat/foo` swapping the branch segment; `print-skill-url` (no flag) prints the `main`-branched URL.
- **Modify** `src/cli/index.ts` — import `agentCommand` from `./commands/agent.js` and register it via `program.addCommand(agentCommand());`. Placement: alphabetical neighborhood with the other top-level commands (after `addCommand(initCommand())` since `agent` < `blind`).
- **Modify** `src/daemon/api/routes/health.ts` — extend the response object with an `agentic_browser` field: `{ available, browser_started, proxy_active, handles_supported, marks_active }`. `browser_started` and `proxy_active` mirror the existing top-level fields (the new block is the spec'd shape; the top-level fields stay for back-compat). `handles_supported` is the literal `true` (this daemon build always supports handles after Phase 1). `marks_active` is `services.handles.list().length` (the existing `list()` method already prunes expired entries — see `browser-handles.ts:58-68`; this is a **count only**, never the labels, never the DOM text). `available = (browser_started && proxy_active && handles_supported)`.
- **Modify** `src/daemon/api/routes.test.ts` — extend the existing `/v1/health` test (`routes.test.ts:823-835`) to also assert `agentic_browser.available === false` (browser not started in `withDaemon`); add a NEW test that puts a stub browser + stub proxy + a handle on `services` and asserts `agentic_browser.available === true` + `marks_active === 1`; add a NEG test that confirms the response **never** contains the handle's `label` or `handle_fingerprint` (only the count). Reuse the existing `withDaemon` + the `stubBrowser`/stub-proxy patterns already in the test file.
- **Modify** `src/cli/commands/doctor.ts` — read `health.agentic_browser?.available` and emit one new text line `agentic flows: available` or `agentic flows: unavailable (start browser)`. The JSON output already includes the full `health` object verbatim, so the new field is exposed in `--json` automatically without further code; document this in the cli-reference change.
- **Create** `src/cli/commands/doctor.test.ts` — text-output tests using a tiny in-process stub of `daemonRequest` (monkey-patch via a `vi.mock`-like ESM import shim — or, since this codebase does NOT use vitest, an explicit module-rewrite via `await import("../../client/daemon-client.js")` with a re-exported `daemonRequest` indirection; see Task 6 step-by-step for the exact mechanism). Three cases: `available=true` → line says "available"; `available=false` → line says "unavailable (start browser)"; `agentic_browser` field missing (e.g. older daemon) → line says "unavailable (start browser)" (safe default — missing-field is treated as unavailable). Also assert JSON-mode output includes the `agentic_browser` block under `health`.
- **Modify** `README.md` — (a) add a new "For agents" section just below the "Quickstart" section: "For agents, paste this raw skill URL into your agent: `https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md`" plus a 4-line "If you have the CLI installed locally, run `secret-shuttle agent install <claude|codex|cursor|copilot>` from your project root and the platform-specific instructions file is written for you." (b) update the "Docs" list to add `[skills/secret-shuttle/SKILL.md](skills/secret-shuttle/SKILL.md)`. Do not touch the rest of README.
- **Modify** `docs/cli-reference.md` — append a new `## secret-shuttle agent install | print-skill-url` section (one paragraph per subcommand). Also append a new paragraph to the existing `## secret-shuttle doctor` section about the `agentic flows:` line.
- **Create** `src/e2e/agent-install-no-leak.test.ts` — daemon-free e2e for the installers: spawns the built `dist/cli/index.js` as a child process under a tmp dir CWD via `node:child_process.spawnSync`, runs `agent install claude` then `agent install codex` then `agent install codex` again, then inspects the resulting tree (`.claude/skills/secret-shuttle/SKILL.md` matches the source skill byte-for-byte; `AGENTS.md` contains exactly one `<!-- secret-shuttle:begin -->`/`<!-- secret-shuttle:end -->` pair; if a sentinel non-secret-shuttle line existed in `AGENTS.md` pre-install, it survives the install). Also runs `agent print-skill-url` and asserts the stdout matches the derived URL via `deriveSkillUrl` against the package's own `package.json`.

**Branch:** all work on a feature branch — run `git switch -c feat/skill-installers` as the first step; **do not implement on `main`**. Phases 2–4 used this branch model (each merged cleanly into `main` via fast-forward); mirror it.

Commands:
- Build: `npm run build`
- Typecheck only: `npm run typecheck`
- Full test: `npm test` (builds, then `SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/**/*.test.js"`)
- One test file: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/<path>.test.js`

---

### Task 1: Branch + create canonical `skills/secret-shuttle/SKILL.md` + retire `skills/claude-code/SKILL.md`

**Files:**
- Create: `skills/secret-shuttle/SKILL.md`
- Delete: `skills/claude-code/SKILL.md`
- Modify: `package.json` (`files` array)

> The canonical skill is the source of truth from which every later installer derives its written output, so it must exist before any code that reads it. Retiring the claude-code skill in the same task keeps the `files` array consistent (the old `"skills"` blanket entry shipped the whole directory; the new entry is the explicit `"skills/secret-shuttle/SKILL.md"` path). We do **not** keep a redirect note at the old path — the package.json change removes it from the shipped tarball; the git history preserves the original.

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git switch -c feat/skill-installers
```
Expected: `Switched to a new branch 'feat/skill-installers'`

- [ ] **Step 2: Author the canonical skill**

Create `skills/secret-shuttle/SKILL.md` with the following content verbatim (this is the source of truth — every installer reads it; the per-provider statement honestly reflects the PENDING gate outcomes per the Scope note):

```markdown
# Secret Shuttle — Agent Operating Manual

You are an agent. This is your operating manual for using Secret Shuttle. The
human will not see these directives unless they read this file. Read top to
bottom; the order matters.

## Before any secret operation

1. Run `secret-shuttle doctor --json` first. If `daemon_reachable` is `false`,
   run `secret-shuttle daemon start`. If `unlocked` is `false`, run
   `secret-shuttle unlock` (the human enters the passphrase in the browser
   window; the CLI never reads it). If `agentic_browser.available` is `false`,
   run `secret-shuttle browser start`. Re-check `doctor --json` after each
   action — do not proceed until every prerequisite is `true`.

## Prefer `template run` over generic browser ops

2. Before reaching for the browser, check `secret-shuttle template list`. If a
   shipped template covers the destination (Vercel env vars, GitHub Actions
   secrets, Cloudflare Workers secrets, Supabase edge secrets), use
   `secret-shuttle template run <id> --ref <ref> --param <k>=<v>` instead of
   the browser flow. Templates are the safer path (the secret reaches the
   provider's CLI on stdin or via a `0600` env-file; never argv, never env).

## Marking elements before blind mode

3. For focusable fields (text inputs, contenteditable, password inputs):
   focus the element with your normal browser tool, then run
   `secret-shuttle browser mark focused --as <label>`. The daemon records an
   opaque handle keyed by `<label>`; the agent never sees a selector or a
   DOM path. Re-marking the same label is last-write-wins.

4. For non-focusable controls (buttons, reveal/hide icons, links): use
   `mark pick`. `mark pick` blocks until a pick happens, so **you** (not a
   human) drive the choreography:
   - Start `secret-shuttle browser mark pick --as <label>` in the background
     (your runtime's non-blocking shell, or a separate tool turn — do not
     await it yet).
   - Immediately use your browser tool to click the target element. Chrome's
     inspect overlay highlights it; the click is browser-consumed (no page
     event fires — an app's earlier-registered window-capture handler cannot
     reveal/submit during marking).
   - Now await the `mark pick` command. It returns the handle.
   - **Fallback** if your runtime cannot drive browser and terminal
     concurrently: prefer `mark focused` for any focusable control. If the
     control is not focusable and concurrent control is impossible for your
     runtime, the flow cannot be fully agentic for that element — stop and
     surface this to the human. Do NOT skip the mark.

## The secret-bearing transaction

5. Use `inject-submit` (write a secret into a field and click submit) or
   `reveal-capture` (click a reveal control, capture the revealed secret,
   click hide). These open a human-approval window in the browser. Approve
   the request there — there is no CLI flag that bypasses approval.

   - `inject-submit --ref ss://... --field-handle <label> --submit-handle <label> --success-text "<text>"`
   - `reveal-capture --name <NAME> --env <env> --source <source> --reveal-handle <label> [--field-handle <label>|--container-handle <label>|--capture focused-after-reveal] [--hide-handle <label>] --allow-domain <domain>`

## Observation during blind mode

6. **NEVER** during blind mode:
   - take a screenshot
   - inspect the DOM
   - read page text, accessibility tree, or console
   - read network response bodies
   - read the clipboard
   - call any browser tool that returns page content

   The daemon does these internally for the absence proof — you must not. The
   daemon's CDP proxy will block these calls, but the contract is that **you
   do not even attempt them**.

## Interpreting enum responses

7. Responses are enum-only. The raw secret value is never in any response
   body. The agent must:
   - report only the enum status, the ref, the fingerprint, the domain, and
     the success/failure signal — never any captured text, never any DOM
     snippet
   - on `next: "manual_recovery_required"`: **do not** attempt to resume
     observation yourself. Surface this to the human (the human-approved
     `secret-shuttle blind end` is the only recovery). Auto-resume bypassed
     because the daemon could not prove the secret is gone; the human owns
     the recovery decision.
   - on success: the daemon has already auto-resumed observation. You may
     continue normally — but still never report the raw value (you never had
     access to it).

## Safe output

It is safe to report:
- secret refs (`ss://stripe/prod/STRIPE_WEBHOOK_SECRET`)
- fingerprints (`fp:abcdef…`)
- domains (`dashboard.stripe.com`)
- secret names + environments
- status enums (`submitted:true`, `captured:true`, `next:"manual_recovery_required"`)

It is **never** safe to report raw secret values.

## Provider browser-flow status

The browser-driven flows (`inject-submit` for Vercel-style env-var writes,
`reveal-capture` for Stripe-style secret reveals) depend on the target
provider's page structure. The Phase-2 and Phase-3 [P2a] real-page gates and
the Phase-4 [P2b] template-CLI gates record per-provider production-or-best-
effort status in this repository's plan files:

- Vercel browser flow ([P2a], Phase-2 plan): **PENDING** — see
  `docs/superpowers/plans/2026-05-18-agentic-blind-transactions-phase2-inject-submit.md`
  "## [P2a] Gate outcome".
- Stripe browser flow ([P2a], Phase-3 plan): **PENDING** (user-deferred) —
  see `docs/superpowers/plans/2026-05-19-agentic-blind-transactions-phase3-reveal-capture.md`
  "## [P2a] Gate outcome".
- Provider templates ([P2b], Phase-4 plan): **PENDING** — see
  `docs/superpowers/plans/2026-05-20-agentic-blind-transactions-phase4-templates.md`
  "## [P2b] Gate outcome".

Until those gates are recorded as PASS, treat every browser flow as
**best-effort**. The absence proof stays conservatively fail-closed regardless
(the daemon refuses to auto-resume unless it can prove the secret is gone), so
"best-effort" means "auto-resume may not succeed on every page", not "the
secret may leak". When in doubt, use `template run` for the four shipped
templates (`vercel-env-add`, `github-actions-secret-set`,
`cloudflare-secret-put`, `supabase-edge-secret-set`).

## Recap of forbidden actions during blind mode

- screenshots
- DOM inspection
- page-text reads
- accessibility tree reads
- console reads
- network-body reads
- clipboard reads
- any browser tool that returns page content

The daemon does these internally for the absence proof. You do not.
```

- [ ] **Step 3: Delete the retired claude-code skill**

Run:
```bash
git rm skills/claude-code/SKILL.md
rmdir skills/claude-code
```
Expected: the file is deleted and the empty directory is removed. `git status` shows the deletion as staged.

- [ ] **Step 4: Update `package.json` files array**

In `package.json`, the current `files` array is (lines 9-23):
```json
  "files": [
    "dist",
    "!dist/**/*.test.js",
    "!dist/**/*.test.js.map",
    "!dist/**/*.test.d.ts",
    "!dist/**/*.js.map",
    "!dist/**/*.tsbuildinfo",
    "skills",
    "agents",
    "docs",
    "!docs/superpowers/**",
    "examples",
    "README.md",
    "LICENSE"
  ],
```

Replace the `"skills"` entry with the explicit canonical path:
```json
  "files": [
    "dist",
    "!dist/**/*.test.js",
    "!dist/**/*.test.js.map",
    "!dist/**/*.test.d.ts",
    "!dist/**/*.js.map",
    "!dist/**/*.tsbuildinfo",
    "skills/secret-shuttle/SKILL.md",
    "agents",
    "docs",
    "!docs/superpowers/**",
    "examples",
    "README.md",
    "LICENSE"
  ],
```

- [ ] **Step 5: Verify the retired path is not referenced anywhere shipped**

Run:
```bash
git grep -n "skills/claude-code" -- ':!docs/superpowers/' ':!.git/'
```
Expected: no hits in shipped files. (Hits in `docs/superpowers/plans/*.md` are acceptable — those are dev plans, not shipped.)

- [ ] **Step 6: Verify the new canonical path exists and is the source of truth**

Run:
```bash
ls -la skills/secret-shuttle/SKILL.md
wc -l skills/secret-shuttle/SKILL.md
```
Expected: the file exists; line count > 80 (the verbatim content above is roughly 120-130 lines).

- [ ] **Step 7: Commit Task 1**

Run:
```bash
git add skills/secret-shuttle/SKILL.md package.json
git rm -r skills/claude-code
git commit -m "$(cat <<'EOF'
feat(skill): canonical skills/secret-shuttle/SKILL.md + retire skills/claude-code (spec §10.1)

The new skill is the agent-facing source of truth; installers (Task 5) derive
platform files from it. Drops the obsolete claude-code-only skill and updates
package.json files to ship only the canonical path.

Provider browser-flow status block honestly reports the [P2a]/[P2b] gates as
PENDING (Phase 2/3 Vercel/Stripe + Phase 4 templates) — the skill must not
misrepresent provider status.
EOF
)"
```
Expected: commit succeeds; `git log -1 --name-status` shows the new SKILL.md, the deletion, and the package.json modify.

---

### Task 2: Add `repository` field to `package.json`

**Files:**
- Modify: `package.json`

> The `repository` field is the single source of truth for the raw-GitHub URL. `print-skill-url` derives the URL from it (no hardcoding) so the URL cannot drift when the repo is forked or renamed. The field follows the npm convention: `{ "type": "git", "url": "https://github.com/<owner>/<repo>.git" }`.

- [ ] **Step 1: Inspect the current package.json top-level shape**

Run:
```bash
node -e "const p = require('./package.json'); console.log(Object.keys(p).join('\\n'));"
```
Expected: lists keys in order: `name`, `version`, `description`, `type`, `bin`, `files`, `scripts`, `keywords`, `license`, `engines`, `dependencies`, `devDependencies`. Confirms `repository` is currently absent.

- [ ] **Step 2: Insert the `repository` field**

In `package.json`, between the `"description"` line (line 4) and the `"type"` line (line 5), insert the `repository` field. The keys in the npm tooling convention are read from any order, but conventionally `repository` sits near `description`/`homepage`. After the edit, lines 1-7 read:

```json
{
  "name": "secret-shuttle",
  "version": "0.1.1",
  "description": "A local blind-secret bridge for AI coding agents.",
  "repository": {
    "type": "git",
    "url": "https://github.com/pdumicz/secret-shuttle.git"
  },
  "type": "module",
```

- [ ] **Step 3: Verify the JSON is still valid**

Run:
```bash
node -e "const p = require('./package.json'); console.log(p.repository.url);"
```
Expected: `https://github.com/pdumicz/secret-shuttle.git`

- [ ] **Step 4: Commit Task 2**

Run:
```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore(pkg): add repository field for print-skill-url derivation (spec §10.2)

The new agent print-skill-url command derives the raw-GitHub URL from this
field rather than hardcoding it — defense against fork/rename drift.
EOF
)"
```
Expected: commit succeeds.

---

### Task 3: Implement `deriveSkillUrl` pure helper + tests

**Files:**
- Create: `src/cli/skill-url.ts`
- Create: `src/cli/skill-url.test.ts`

> Pure-function helper; no I/O. The transform is `https://github.com/<owner>/<repo>(.git)?` → `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`. We support the common npm-supported `repository.url` shapes: `git+https://github.com/...`, `https://github.com/...`, `github:owner/repo` shorthand, and `git://github.com/...`. Non-github hosts throw fail-closed (the spec ties the URL to raw.githubusercontent.com — if the operator forks to a different host, they must explicitly override via `--branch` plus a future `--host` flag, which is out of scope for Phase 5).

- [ ] **Step 1: Write the failing helper tests**

Create `src/cli/skill-url.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { deriveSkillUrl } from "./skill-url.js";

test("deriveSkillUrl handles https://github.com/<o>/<r>.git", () => {
  const url = deriveSkillUrl({ repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles https://github.com/<o>/<r> (no .git suffix)", () => {
  const url = deriveSkillUrl({ repository: { url: "https://github.com/pdumicz/secret-shuttle" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles git+https:// prefix", () => {
  const url = deriveSkillUrl({ repository: { url: "git+https://github.com/pdumicz/secret-shuttle.git" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles github:owner/repo shorthand", () => {
  const url = deriveSkillUrl({ repository: { url: "github:pdumicz/secret-shuttle" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles repository as a string (npm sugar)", () => {
  const url = deriveSkillUrl({ repository: "github:pdumicz/secret-shuttle" });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl branch override swaps only the branch segment", () => {
  const url = deriveSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    { branch: "feat/skill-installers" },
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/feat/skill-installers/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl path override swaps only the path segment", () => {
  const url = deriveSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    { path: "skills/secret-shuttle/OTHER.md" },
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/OTHER.md");
});

test("deriveSkillUrl throws repository_field_missing when repository is absent", () => {
  assert.throws(
    () => deriveSkillUrl({}),
    (e: unknown) => e instanceof Error && /repository_field_missing/.test(e.message),
  );
});

test("deriveSkillUrl throws repository_field_missing when repository.url is empty", () => {
  assert.throws(
    () => deriveSkillUrl({ repository: { url: "" } }),
    (e: unknown) => e instanceof Error && /repository_field_missing/.test(e.message),
  );
});

test("deriveSkillUrl throws when repository host is not github", () => {
  assert.throws(
    () => deriveSkillUrl({ repository: { url: "https://gitlab.com/pdumicz/secret-shuttle.git" } }),
    (e: unknown) => e instanceof Error && /unsupported_repository_host/.test(e.message),
  );
});
```

- [ ] **Step 2: Run the failing test (must FAIL to compile because `skill-url.ts` does not exist yet)**

Run:
```bash
npm run build
```
Expected: FAIL — `error TS2307: Cannot find module './skill-url.js'` or similar.

- [ ] **Step 3: Implement `skill-url.ts`**

Create `src/cli/skill-url.ts`:

```ts
import { ShuttleError } from "../shared/errors.js";

export interface RepositoryField {
  /** npm allows repository to be a string (shorthand) or an object with `url`. */
  repository?: string | { url?: string };
}

export interface DeriveOpts {
  /** Branch (or ref — same field) to splice into the raw URL. Default: "main". */
  branch?: string;
  /** Path within the repo. Default: "skills/secret-shuttle/SKILL.md". */
  path?: string;
}

const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "skills/secret-shuttle/SKILL.md";

/**
 * Pure helper. Given an npm-style `repository` field, derive the
 * raw.githubusercontent.com URL for the canonical SKILL.md. Throws
 * ShuttleError fail-closed if the field is absent, empty, or points
 * at a non-github host (no silent fall-back to a hardcoded URL).
 */
export function deriveSkillUrl(pkg: RepositoryField, opts: DeriveOpts = {}): string {
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const path = opts.path ?? DEFAULT_PATH;
  const raw = typeof pkg.repository === "string"
    ? pkg.repository
    : (pkg.repository?.url ?? "");
  if (raw === "" || raw === undefined) {
    throw new ShuttleError(
      "repository_field_missing",
      "package.json is missing a repository field — cannot derive skill URL.",
    );
  }
  // Normalize git+https:// → https://; strip trailing .git
  let normalized = raw.replace(/^git\+/, "").replace(/\.git$/, "");
  // Handle shorthand "github:owner/repo"
  const shorthand = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalized);
  let owner: string;
  let repo: string;
  if (shorthand !== null) {
    owner = shorthand[1] ?? "";
    repo = shorthand[2] ?? "";
  } else {
    // Match https://github.com/<owner>/<repo>
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalized);
    if (m === null) {
      throw new ShuttleError(
        "unsupported_repository_host",
        `repository.url must be a github.com URL; got: ${raw}`,
      );
    }
    owner = m[1] ?? "";
    repo = m[2] ?? "";
  }
  if (owner === "" || repo === "") {
    throw new ShuttleError(
      "repository_field_missing",
      `repository.url did not parse to owner/repo; got: ${raw}`,
    );
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}
```

- [ ] **Step 4: Run the tests — they should now PASS**

Run:
```bash
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/cli/skill-url.test.js
```
Expected: all 9 tests pass.

- [ ] **Step 5: Commit Task 3**

Run:
```bash
git add src/cli/skill-url.ts src/cli/skill-url.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): deriveSkillUrl pure helper (spec §10.2)

Derives the canonical raw.githubusercontent.com URL from package.json's
repository field — fail-closed on missing field or non-github host. No
hardcoded URLs anywhere; print-skill-url (Task 5) consumes this.

Tests cover https/.git/no-.git/git+https/github-shorthand/repository-as-string
shapes plus branch + path overrides and the two failure modes.
EOF
)"
```

---

### Task 4: Implement `writeAgentFile` + `writeAgentSnippet` I/O helpers + tests

**Files:**
- Create: `src/cli/agent-writer.ts`
- Create: `src/cli/agent-writer.test.ts`

> Two I/O helpers, both atomic. `writeAgentFile` is wholesale overwrite for Secret-Shuttle-owned files. `writeAgentSnippet` is the marker-based idempotent writer for files we share with the user (AGENTS.md, .github/copilot-instructions.md). Both helpers mkdir-p the parent directory and use temp+rename for atomicity.

- [ ] **Step 1: Write the failing helper tests**

Create `src/cli/agent-writer.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeAgentFile, writeAgentSnippet } from "./agent-writer.js";

const BEGIN = "<!-- secret-shuttle:begin -->";
const END = "<!-- secret-shuttle:end -->";

async function tmpRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "ss-agent-writer-"));
}

test("writeAgentFile creates a new file with exact content and 0644 mode", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "sub", "dir", "SKILL.md");
  await writeAgentFile({ targetPath: target, content: "hello\n" });
  assert.equal(await readFile(target, "utf8"), "hello\n");
  const st = await stat(target);
  assert.equal((st.mode & 0o777).toString(8), "644");
});

test("writeAgentFile overwrites an existing file wholesale", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "SKILL.md");
  await writeFile(target, "OLD-SENTINEL\noriginal content\n");
  await writeAgentFile({ targetPath: target, content: "NEW\n" });
  const got = await readFile(target, "utf8");
  assert.equal(got, "NEW\n");
  assert.ok(!got.includes("OLD-SENTINEL"));
});

test("writeAgentSnippet creates a new file with just the marked block when target is missing", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "deep", "AGENTS.md");
  await writeAgentSnippet({ targetPath: target, content: "body\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  assert.equal(got, `${BEGIN}\nbody\n${END}\n`);
});

test("writeAgentSnippet round-trip replaces ONLY the marked block on second run", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  // Pre-existing AGENTS.md with sentinels around the block we will manage
  const pre = "SENTINEL-BEFORE\n\n<!-- secret-shuttle:begin -->\nOLD\n<!-- secret-shuttle:end -->\n\nSENTINEL-AFTER\n";
  await writeFile(target, pre);
  await writeAgentSnippet({ targetPath: target, content: "NEW BODY\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  assert.equal(
    got,
    "SENTINEL-BEFORE\n\n<!-- secret-shuttle:begin -->\nNEW BODY\n<!-- secret-shuttle:end -->\n\nSENTINEL-AFTER\n",
  );
  assert.ok(!got.includes("OLD"));
  assert.ok(got.includes("SENTINEL-BEFORE"));
  assert.ok(got.includes("SENTINEL-AFTER"));
});

test("writeAgentSnippet appends a new block when the existing file lacks markers", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  await writeFile(target, "USER-CONTENT\n");
  await writeAgentSnippet({ targetPath: target, content: "ours\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  // We append two leading newlines before the block to keep a visual gap
  assert.equal(got, `USER-CONTENT\n\n\n${BEGIN}\nours\n${END}\n`);
});

test("writeAgentSnippet treats begin-without-end as 'lacks markers' (appends a new block, leaves the malformed half alone)", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  await writeFile(target, `USER-CONTENT\n${BEGIN}\nORPHAN\n`); // no END marker
  await writeAgentSnippet({ targetPath: target, content: "ours\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  // The orphan BEGIN line is preserved (we do not attempt repair)
  assert.ok(got.includes("ORPHAN"));
  // A new well-formed block is appended at end
  assert.ok(got.endsWith(`${BEGIN}\nours\n${END}\n`));
});

test("writeAgentSnippet running twice with same content is byte-identical (idempotent)", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  await writeAgentSnippet({ targetPath: target, content: "same\n", beginMarker: BEGIN, endMarker: END });
  const after1 = await readFile(target, "utf8");
  await writeAgentSnippet({ targetPath: target, content: "same\n", beginMarker: BEGIN, endMarker: END });
  const after2 = await readFile(target, "utf8");
  assert.equal(after1, after2);
});

test("writeAgentSnippet mkdir-p creates a missing parent directory", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "a", "b", "c", "AGENTS.md");
  await writeAgentSnippet({ targetPath: target, content: "body\n", beginMarker: BEGIN, endMarker: END });
  assert.equal(await readFile(target, "utf8"), `${BEGIN}\nbody\n${END}\n`);
});
```

- [ ] **Step 2: Run the failing test**

Run:
```bash
npm run build
```
Expected: FAIL to compile — `Cannot find module './agent-writer.js'`.

- [ ] **Step 3: Implement `agent-writer.ts`**

Create `src/cli/agent-writer.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface WriteAgentFileOpts {
  targetPath: string;
  content: string;
}

/**
 * Wholesale overwrite. The target is Secret-Shuttle-owned (e.g.
 * .claude/skills/secret-shuttle/SKILL.md, .cursor/rules/secret-shuttle.mdc).
 * Atomic via temp + rename. mkdir -p the parent.
 * File mode 0644 (world-readable; this is a normal config file).
 */
export async function writeAgentFile(opts: WriteAgentFileOpts): Promise<void> {
  await mkdir(path.dirname(opts.targetPath), { recursive: true });
  const tmpPath = `${opts.targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, opts.content, { mode: 0o644 });
  await rename(tmpPath, opts.targetPath);
}

export interface WriteAgentSnippetOpts {
  targetPath: string;
  content: string;
  beginMarker: string;
  endMarker: string;
}

/**
 * Idempotent marker-based snippet writer. Target is user-owned but contains
 * one block managed by Secret Shuttle, delimited by beginMarker..endMarker
 * (HTML/Markdown comments).
 *
 *   - File missing → create with `${begin}\n${content}\n${end}\n`.
 *   - File has BOTH markers → replace the byte range from `begin` line through
 *     `end` line (inclusive) with the new marked block; every other byte
 *     preserved.
 *   - File lacks one or both markers → append two leading newlines + new
 *     marked block at end-of-file. The pre-existing bytes (including any
 *     orphan marker half) are preserved — we never attempt repair.
 *
 * Atomic via temp + rename.
 */
export async function writeAgentSnippet(opts: WriteAgentSnippetOpts): Promise<void> {
  await mkdir(path.dirname(opts.targetPath), { recursive: true });
  const newBlock = `${opts.beginMarker}\n${opts.content}${opts.content.endsWith("\n") ? "" : "\n"}${opts.endMarker}\n`;
  let existing: string | null = null;
  try {
    existing = await readFile(opts.targetPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    existing = null;
  }
  let out: string;
  if (existing === null) {
    out = newBlock;
  } else {
    const beginIdx = existing.indexOf(opts.beginMarker);
    const endIdx = existing.indexOf(opts.endMarker);
    if (beginIdx >= 0 && endIdx > beginIdx) {
      // Expand the replacement range to include trailing newline after endMarker
      // (so a second run produces byte-identical output and the surrounding
      // user content keeps its original whitespace).
      const afterEnd = endIdx + opts.endMarker.length;
      const trailingNl = existing[afterEnd] === "\n" ? 1 : 0;
      const before = existing.slice(0, beginIdx);
      const after = existing.slice(afterEnd + trailingNl);
      out = before + newBlock + after;
    } else {
      // Markers missing (or malformed) — append at end with a visual gap.
      const sep = existing.endsWith("\n") ? "\n" : "\n\n";
      out = existing + sep + newBlock;
    }
  }
  const tmpPath = `${opts.targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, out, { mode: 0o644 });
  await rename(tmpPath, opts.targetPath);
}
```

- [ ] **Step 4: Run the tests — they should now PASS**

Run:
```bash
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/cli/agent-writer.test.js
```
Expected: all 8 tests pass.

- [ ] **Step 5: Commit Task 4**

Run:
```bash
git add src/cli/agent-writer.ts src/cli/agent-writer.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): writeAgentFile + writeAgentSnippet helpers (spec §10.2)

writeAgentFile is the wholesale-overwrite primitive for Secret-Shuttle-owned
files (.claude/skills/.../SKILL.md, .cursor/rules/secret-shuttle.mdc).
writeAgentSnippet is the idempotent marker-based primitive for user-owned
files (AGENTS.md, .github/copilot-instructions.md). Both atomic via
temp+rename and mkdir -p the parent.

Tests cover idempotency (byte-identical second run), surrounding-content
preservation, orphan-marker passthrough (no repair), parent-dir creation,
and the missing-target case.
EOF
)"
```

---

### Task 5: Implement `agent install` + `agent print-skill-url` Commander subcommands + tests

**Files:**
- Create: `src/cli/commands/agent.ts`
- Create: `src/cli/commands/agent.test.ts`
- Modify: `src/cli/index.ts` (register the new command group)

> The `agent` subcommand group has two children: `install <target>` (`target ∈ {claude, codex, cursor, copilot}`) and `print-skill-url`. The skill content is read at runtime from the package's own bundled `skills/secret-shuttle/SKILL.md` via `import.meta.url` resolution. Each `install <target>` resolves the per-target destination relative to `process.cwd()` and dispatches to either `writeAgentFile` (claude/cursor — wholesale) or `writeAgentSnippet` (codex/copilot — marker block).

- [ ] **Step 1: Write the failing CLI test**

Create `src/cli/commands/agent.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { agentInstallTarget, agentPrintSkillUrl } from "./agent.js";

const BEGIN = "<!-- secret-shuttle:begin -->";
const END = "<!-- secret-shuttle:end -->";

async function tmpCwd(): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(path.join(tmpdir(), "ss-agent-cli-"));
  const orig = process.cwd();
  process.chdir(root);
  return { root, restore: () => process.chdir(orig) };
}

const FAKE_SKILL_CONTENT = "# Fake Skill\nbody\n";

test("agentInstallTarget('claude') writes wholesale to .claude/skills/secret-shuttle/SKILL.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("claude", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".claude/skills/secret-shuttle/SKILL.md"), "utf8");
    assert.equal(out, FAKE_SKILL_CONTENT);
  } finally { restore(); }
});

test("agentInstallTarget('cursor') writes wholesale to .cursor/rules/secret-shuttle.mdc", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("cursor", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".cursor/rules/secret-shuttle.mdc"), "utf8");
    assert.equal(out, FAKE_SKILL_CONTENT);
  } finally { restore(); }
});

test("agentInstallTarget('codex') writes a marked snippet to AGENTS.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.ok(out.startsWith(BEGIN));
    assert.ok(out.includes(FAKE_SKILL_CONTENT));
    assert.ok(out.endsWith(`${END}\n`));
  } finally { restore(); }
});

test("agentInstallTarget('copilot') writes a marked snippet to .github/copilot-instructions.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("copilot", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
    assert.ok(out.includes(BEGIN));
    assert.ok(out.includes(FAKE_SKILL_CONTENT));
  } finally { restore(); }
});

test("agentInstallTarget('codex') is idempotent — exactly one marked block after two runs", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, "AGENTS.md"), "utf8");
    const beginCount = (out.match(new RegExp(BEGIN.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
    const endCount = (out.match(new RegExp(END.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
    assert.equal(beginCount, 1);
    assert.equal(endCount, 1);
  } finally { restore(); }
});

test("agentInstallTarget('codex') preserves preexisting AGENTS.md content outside the block", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await writeFile(path.join(root, "AGENTS.md"), "USER-CONTENT-BEFORE\n");
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.ok(out.includes("USER-CONTENT-BEFORE"));
    assert.ok(out.includes(BEGIN));
  } finally { restore(); }
});

test("agentInstallTarget('claude') is wholesale-overwrite", async () => {
  const { root, restore } = await tmpCwd();
  try {
    const dest = path.join(root, ".claude/skills/secret-shuttle/SKILL.md");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, "OLD-SENTINEL\n");
    await agentInstallTarget("claude", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(dest, "utf8");
    assert.ok(!out.includes("OLD-SENTINEL"));
    assert.equal(out, FAKE_SKILL_CONTENT);
  } finally { restore(); }
});

test("agentPrintSkillUrl returns the derived URL with default branch=main", () => {
  const url = agentPrintSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    {},
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("agentPrintSkillUrl honors --branch override", () => {
  const url = agentPrintSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    { branch: "feat/x" },
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/feat/x/skills/secret-shuttle/SKILL.md");
});
```

- [ ] **Step 2: Run the failing test**

Run:
```bash
npm run build
```
Expected: FAIL to compile — `Cannot find module './agent.js'`.

- [ ] **Step 3: Implement `agent.ts`**

Create `src/cli/commands/agent.ts`:

```ts
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShuttleError } from "../../shared/errors.js";
import { writeAgentFile, writeAgentSnippet } from "../agent-writer.js";
import { deriveSkillUrl, type RepositoryField } from "../skill-url.js";

const BEGIN_MARKER = "<!-- secret-shuttle:begin -->";
const END_MARKER = "<!-- secret-shuttle:end -->";

export type AgentTarget = "claude" | "codex" | "cursor" | "copilot";

interface TargetSpec {
  /** Destination path relative to cwd. */
  destPath: string;
  /** Write mode. */
  mode: "wholesale" | "snippet";
}

const TARGETS: Record<AgentTarget, TargetSpec> = {
  claude:  { destPath: ".claude/skills/secret-shuttle/SKILL.md", mode: "wholesale" },
  codex:   { destPath: "AGENTS.md",                              mode: "snippet"   },
  cursor:  { destPath: ".cursor/rules/secret-shuttle.mdc",       mode: "wholesale" },
  copilot: { destPath: ".github/copilot-instructions.md",        mode: "snippet"   },
};

/**
 * Resolves the package's bundled SKILL.md. When running from the built
 * dist/cli/commands/agent.js, the package root is two levels up.
 * Falls back to walking up four levels for source-mode invocation.
 */
async function readBundledSkill(): Promise<string> {
  const here = fileURLToPath(import.meta.url);
  // .../dist/cli/commands/agent.js → walk up to package root then into skills/
  const candidates = [
    path.resolve(path.dirname(here), "..", "..", "..", "skills", "secret-shuttle", "SKILL.md"),
    path.resolve(path.dirname(here), "..", "..", "skills", "secret-shuttle", "SKILL.md"),
  ];
  for (const c of candidates) {
    try { return await readFile(c, "utf8"); } catch { /* try next */ }
  }
  throw new ShuttleError(
    "skill_bundled_file_missing",
    "Could not locate the bundled skills/secret-shuttle/SKILL.md. Reinstall secret-shuttle.",
  );
}

async function readBundledPackageJson(): Promise<RepositoryField> {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    path.resolve(path.dirname(here), "..", "..", "..", "package.json"),
    path.resolve(path.dirname(here), "..", "..", "package.json"),
  ];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, "utf8");
      return JSON.parse(raw) as RepositoryField;
    } catch { /* try next */ }
  }
  throw new ShuttleError(
    "package_json_missing",
    "Could not locate the package.json bundled with secret-shuttle.",
  );
}

/**
 * Programmatic entry point used by tests + the Commander action handler.
 * Writes the skill content to the target's spec'd destination under `cwd`.
 */
export async function agentInstallTarget(
  target: AgentTarget,
  opts: { skillContent: string; cwd: string },
): Promise<void> {
  const spec = TARGETS[target];
  const dest = path.resolve(opts.cwd, spec.destPath);
  if (spec.mode === "wholesale") {
    await writeAgentFile({ targetPath: dest, content: opts.skillContent });
  } else {
    await writeAgentSnippet({
      targetPath: dest,
      content: opts.skillContent,
      beginMarker: BEGIN_MARKER,
      endMarker: END_MARKER,
    });
  }
}

/** Programmatic entry point for tests. Returns the URL string. */
export function agentPrintSkillUrl(
  pkg: RepositoryField,
  opts: { branch?: string },
): string {
  return deriveSkillUrl(pkg, opts.branch !== undefined ? { branch: opts.branch } : {});
}

export function agentCommand(): Command {
  const agent = new Command("agent")
    .description("Install the Secret Shuttle agent skill into a project (claude/codex/cursor/copilot) or print the raw skill URL.");

  agent
    .command("install <target>")
    .description("Write the Secret Shuttle skill into the project so the named agent can read it. Operates on the current working directory. target = claude | codex | cursor | copilot.")
    .action(async (target: string) => {
      if (target !== "claude" && target !== "codex" && target !== "cursor" && target !== "copilot") {
        throw new ShuttleError(
          "bad_request",
          `target must be one of: claude, codex, cursor, copilot. Got: ${target}`,
        );
      }
      const skillContent = await readBundledSkill();
      await agentInstallTarget(target, { skillContent, cwd: process.cwd() });
      const spec = TARGETS[target];
      process.stdout.write(`wrote ${spec.destPath} (${spec.mode})\n`);
    });

  agent
    .command("print-skill-url")
    .description("Print the raw GitHub URL of the canonical SKILL.md (paste this one line into any agent that supports a remote skill URL).")
    .option("--branch <name>", "Override the default 'main' branch.")
    .option("--ref <name>", "Alias for --branch.")
    .action(async (opts: { branch?: string; ref?: string }) => {
      const pkg = await readBundledPackageJson();
      const branch = opts.branch ?? opts.ref;
      const url = agentPrintSkillUrl(pkg, branch !== undefined ? { branch } : {});
      process.stdout.write(`${url}\n`);
    });

  return agent;
}
```

- [ ] **Step 4: Register the new command in `src/cli/index.ts`**

In `src/cli/index.ts`, add the import (alphabetical group with other `./commands/*.js` imports, between `addRoute` lines for `browser` and `blind` — i.e. after the `useAsStdinCommand` import is fine; the exact placement does not matter for runtime, only readability):

```ts
import { agentCommand } from "./commands/agent.js";
```

And register the command alongside the others. Place it after `addCommand(initCommand())` (alphabetical-by-command-name puts `agent` after `init` in this file's existing order; the current file groups by feel rather than strict alphabetical, so the safest spot is at the **bottom** of the addCommand block immediately above the `if (process.argv.length <= 2)` line — that way the new addition is conspicuous in code review). After the edit, the end of the addCommand block reads:

```ts
program.addCommand(daemonCommand());
program.addCommand(migrateCommand());
program.addCommand(doctorCommand());
program.addCommand(agentCommand());
```

- [ ] **Step 5: Run the tests — they should now PASS**

Run:
```bash
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/cli/commands/agent.test.js
```
Expected: all 9 tests pass.

- [ ] **Step 6: Smoke-test the CLI registration**

Run:
```bash
node dist/cli/index.js agent --help
```
Expected: usage text listing two subcommands (`install <target>` and `print-skill-url`), with the descriptions.

Run:
```bash
node dist/cli/index.js agent print-skill-url
```
Expected: exactly one line on stdout: `https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md` (or whatever the current `package.json` `repository.url` derives to).

Run:
```bash
node dist/cli/index.js agent print-skill-url --branch feat/skill-installers
```
Expected: the same URL with `main` replaced by `feat/skill-installers`.

Run from a temp dir:
```bash
TMPCWD=$(mktemp -d)
cd "$TMPCWD"
node "$OLDPWD/dist/cli/index.js" agent install claude
ls -la .claude/skills/secret-shuttle/SKILL.md
cd "$OLDPWD"
rm -rf "$TMPCWD"
```
Expected: writes `.claude/skills/secret-shuttle/SKILL.md` under the tmp dir.

- [ ] **Step 7: Commit Task 5**

Run:
```bash
git add src/cli/commands/agent.ts src/cli/commands/agent.test.ts src/cli/index.ts
git commit -m "$(cat <<'EOF'
feat(cli): agent install + agent print-skill-url (spec §10.2)

`secret-shuttle agent install <claude|codex|cursor|copilot>` writes the
canonical skill into the project's CWD with the per-target destination + write
mode (wholesale full-file vs marker snippet) per spec §10.2.

`secret-shuttle agent print-skill-url` prints the raw GitHub URL derived from
package.json's repository field (Task 3); --branch/--ref override the default
main branch.

Tests cover each target's destination, per-target write mode, idempotency on
re-run, surrounding-content preservation, and the URL with/without --branch.
EOF
)"
```

---

### Task 6: Extend `GET /v1/health` with `agentic_browser` block + tests

**Files:**
- Modify: `src/daemon/api/routes/health.ts`
- Modify: `src/daemon/api/routes.test.ts` (extend existing test + add new ones)

> The spec (§11) requires the response to gain an `agentic_browser` object exposing `available`, `browser_started`, `proxy_active`, `handles_supported`, `marks_active`. `available` ⇔ daemon build supports `inject-submit`/`reveal-capture` (after Phases 2/3 it always does — encoded as the literal `handles_supported: true`) AND `browser_started` AND `proxy_active`. `marks_active` is a count only, never labels or DOM text.

- [ ] **Step 1: Write the failing health-route tests**

In `src/daemon/api/routes.test.ts`, extend the existing test at line 823 ("GET /v1/health reports a structured safety snapshot") and add two new tests. After the existing `assert.equal(h.policy_warnings, null)` line, append the following inside the same `test(…)` block:

```ts
    // Phase 5 — agentic_browser capability block must be present.
    const ab = h.agentic_browser as Record<string, unknown>;
    assert.equal(typeof ab, "object");
    assert.equal(ab.browser_started, false);
    assert.equal(ab.proxy_active, false);
    assert.equal(ab.handles_supported, true);
    assert.equal(ab.marks_active, 0);
    assert.equal(ab.available, false); // browser not started ⇒ unavailable
```

Then, immediately after the existing test (i.e. right before whatever follows on line 836), add two NEW tests:

```ts
test("GET /v1/health.agentic_browser.available is TRUE when both browser+proxy are up and a handle is recorded", async () => {
  await withDaemon(async (ctx) => {
    // Plant a stub browser + a stub proxy + one handle on the daemon services.
    ctx.services.browser = stubBrowser({});
    ctx.services.cdpProxy = {} as unknown as typeof ctx.services.cdpProxy;
    ctx.services.handles.put({
      label: "field-x",
      target_id: "T1",
      domain: "stripe.com",
      page_url_host: "dashboard.stripe.com",
      page_title: "t",
      backend_node_id: 99,
      handle_fingerprint: "fp:test",
      element_kind: "field",
    });
    const r = await call(ctx, "GET", "/v1/health");
    assert.equal(r.status, 200);
    const ab = (r.body as Record<string, unknown>).agentic_browser as Record<string, unknown>;
    assert.equal(ab.browser_started, true);
    assert.equal(ab.proxy_active, true);
    assert.equal(ab.handles_supported, true);
    assert.equal(ab.marks_active, 1);
    assert.equal(ab.available, true);
  });
});

test("GET /v1/health.agentic_browser exposes ONLY counts — no labels, no fingerprints, no DOM text", async () => {
  await withDaemon(async (ctx) => {
    ctx.services.browser = stubBrowser({});
    ctx.services.cdpProxy = {} as unknown as typeof ctx.services.cdpProxy;
    ctx.services.handles.put({
      label: "secret-label-should-not-leak",
      target_id: "T1",
      domain: "stripe.com",
      page_url_host: "dashboard.stripe.com",
      page_title: "t",
      backend_node_id: 99,
      handle_fingerprint: "fp:should-not-leak",
      element_kind: "field",
    });
    const r = await call(ctx, "GET", "/v1/health");
    const blob = JSON.stringify(r.body);
    assert.ok(!blob.includes("secret-label-should-not-leak"), "handle label must not appear in /v1/health");
    assert.ok(!blob.includes("fp:should-not-leak"), "handle fingerprint must not appear in /v1/health");
    assert.ok(!blob.includes("backend_node_id"), "backend_node_id must not appear in /v1/health");
  });
});
```

Note: the existing test uses `stubBrowser({})` and `call(ctx, "GET", …)` helpers — they are already defined at the top of `routes.test.ts`. The new tests reuse them without modification. If the existing `stubBrowser({})` signature does not accept `{}` directly, inspect lines 1–40 of `routes.test.ts` for the actual factory shape and adjust accordingly (the exact factory is part of the existing test harness; the test code above is canonical for the **shape**, not the exact factory invocation).

- [ ] **Step 2: Run the failing tests**

Run:
```bash
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js 2>&1 | grep -E "fail|FAIL|GET /v1/health"
```
Expected: the extended existing test FAILS (the `agentic_browser` field is undefined on the response); the two new tests also FAIL (same reason).

- [ ] **Step 3: Implement the `agentic_browser` block**

In `src/daemon/api/routes/health.ts`, replace the existing return object with the extended shape. After the edit, the file reads:

```ts
import { fileExists, getShuttlePaths } from "../../../shared/config.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

export function registerHealth(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("GET", "/v1/health", async () => {
    const paths = getShuttlePaths();
    const unlocked = services.lock.isUnlocked();
    let policyWarnings: string[] | null = null;
    if (unlocked) {
      const secrets = await services.vault.list();
      policyWarnings = secrets
        .filter((s) => s.environment === "production" && s.allowed_domains.length === 0)
        .map((s) => `${s.ref} is production but has no allowed domains (not injectable; re-create with --allow-domain)`);
    }
    const browserStarted = services.browser !== null;
    const proxyActive = services.cdpProxy !== null;
    // After Phases 1-3, this daemon build always supports inject-submit/reveal-capture
    // handles. Encoded as a literal so consumers can branch on capability.
    const handlesSupported = true;
    const marksActive = services.handles.list().length;
    return {
      daemon: true,
      unlocked,
      blind_mode: services.blind.current(),
      browser_started: browserStarted,
      proxy_active: proxyActive,
      vault: {
        envelope_present: await fileExists(paths.envelopePath),
        legacy_key_present: await fileExists(paths.keyPath),
      },
      policy_warnings: policyWarnings,
      agentic_browser: {
        available: browserStarted && proxyActive && handlesSupported,
        browser_started: browserStarted,
        proxy_active: proxyActive,
        handles_supported: handlesSupported,
        marks_active: marksActive,
      },
      version: 2,
    };
  });
}
```

- [ ] **Step 4: Run the tests — they should now PASS**

Run:
```bash
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/daemon/api/routes.test.js
```
Expected: all health tests pass (the extended existing test + the two new tests). Other tests in `routes.test.ts` continue to pass.

- [ ] **Step 5: Commit Task 6**

Run:
```bash
git add src/daemon/api/routes/health.ts src/daemon/api/routes.test.ts
git commit -m "$(cat <<'EOF'
feat(health): /v1/health.agentic_browser capability block (spec §11)

GET /v1/health now exposes:

  agentic_browser: {
    available,         // browser_started && proxy_active && handles_supported
    browser_started,
    proxy_active,
    handles_supported, // literal true after Phases 1-3
    marks_active       // services.handles.list().length — count only
  }

`marks_active` is a count and only a count — no labels, no fingerprints, no
DOM text. The no-leak test asserts the response never contains any of those.
EOF
)"
```

---

### Task 7: Extend `doctor` CLI with the `agentic flows:` line + tests

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Create: `src/cli/commands/doctor.test.ts`

> The `doctor` text output gains one line `agentic flows: available` or `agentic flows: unavailable (start browser)` derived from `health.agentic_browser.available`. The `--json` output already echoes the full `health` object verbatim (line 33 of `doctor.ts` wraps it as `report.health`), so the new field is included in `--json` automatically — no code change needed for JSON mode. Tests use a programmatic `formatDoctorText` helper that the refactored `doctor.ts` exports for testability (the action handler is the same logic but wrapped for I/O).

- [ ] **Step 1: Write the failing doctor tests**

Create `src/cli/commands/doctor.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorText } from "./doctor.js";

const baseHealth = {
  unlocked: true,
  browser_started: true,
  proxy_active: true,
  blind_mode: null,
  vault: { envelope_present: true, legacy_key_present: false },
  policy_warnings: [],
};

test("formatDoctorText reports 'agentic flows: available' when health.agentic_browser.available is true", () => {
  const out = formatDoctorText({
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      ...baseHealth,
      agentic_browser: {
        available: true,
        browser_started: true,
        proxy_active: true,
        handles_supported: true,
        marks_active: 0,
      },
    },
  });
  assert.match(out, /agentic flows:\s+available/);
});

test("formatDoctorText reports 'agentic flows: unavailable (start browser)' when available is false", () => {
  const out = formatDoctorText({
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: {
      ...baseHealth,
      browser_started: false,
      agentic_browser: {
        available: false,
        browser_started: false,
        proxy_active: false,
        handles_supported: true,
        marks_active: 0,
      },
    },
  });
  assert.match(out, /agentic flows:\s+unavailable \(start browser\)/);
});

test("formatDoctorText defaults to 'unavailable (start browser)' when agentic_browser is missing (older daemon)", () => {
  const out = formatDoctorText({
    daemon_reachable: true,
    daemon_error: null,
    socket_file_mode: "0600",
    socket_file_mode_ok: true,
    health: { ...baseHealth },
  });
  assert.match(out, /agentic flows:\s+unavailable \(start browser\)/);
});

test("formatDoctorText omits the agentic-flows line when health is null (daemon unreachable)", () => {
  const out = formatDoctorText({
    daemon_reachable: false,
    daemon_error: "ECONNREFUSED",
    socket_file_mode: null,
    socket_file_mode_ok: true,
    health: null,
  });
  assert.doesNotMatch(out, /agentic flows:/);
});
```

- [ ] **Step 2: Run the failing tests**

Run:
```bash
npm run build
```
Expected: FAIL to compile — `formatDoctorText` is not exported from `./doctor.js` yet.

- [ ] **Step 3: Refactor `doctor.ts` to export `formatDoctorText` + emit the new line**

In `src/cli/commands/doctor.ts`, replace the contents with the refactored version:

```ts
import { Command } from "commander";
import { stat } from "node:fs/promises";
import { daemonRequest } from "../../client/daemon-client.js";
import { getShuttlePaths } from "../../shared/config.js";
import { ok, outputJson } from "../../shared/result.js";

export interface DoctorReport {
  daemon_reachable: boolean;
  daemon_error: string | null;
  socket_file_mode: string | null;
  socket_file_mode_ok: boolean;
  health: Record<string, unknown> | null;
}

/** Pure formatter for the text-mode output. Exported for unit testing. */
export function formatDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`daemon:        ${report.daemon_reachable ? "reachable" : "NOT reachable"}`);
  if (report.socket_file_mode !== null) {
    lines.push(`socket mode:   ${report.socket_file_mode}${report.socket_file_mode_ok ? " (ok)" : " (EXPECTED 0600)"}`);
  }
  const health = report.health;
  if (health !== null) {
    lines.push(`unlocked:      ${health.unlocked}`);
    lines.push(`browser:       ${health.browser_started ? "started" : "not started"}`);
    lines.push(`proxy:         ${health.proxy_active ? "active" : "inactive"}`);
    lines.push(`blind mode:    ${health.blind_mode === null ? "off" : "ON"}`);
    const v = health.vault as { envelope_present: boolean; legacy_key_present: boolean };
    lines.push(`vault:         envelope=${v.envelope_present} legacy_key=${v.legacy_key_present}${v.legacy_key_present ? " (RUN: secret-shuttle migrate secure-vault)" : ""}`);
    const warns = health.policy_warnings as string[] | null;
    if (warns === null) lines.push(`policy:        (vault locked — unlock to audit)`);
    else if (warns.length === 0) lines.push(`policy:        ok`);
    else { lines.push(`policy:        ${warns.length} warning(s):`); for (const w of warns) lines.push(`  - ${w}`); }
    // Phase 5 — agentic-flows line (spec §11). Missing field ⇒ unavailable
    // (defensive: an older daemon predates the agentic_browser block).
    const ab = (health.agentic_browser as Record<string, unknown> | undefined) ?? undefined;
    const available = ab !== undefined && ab.available === true;
    lines.push(`agentic flows: ${available ? "available" : "unavailable (start browser)"}`);
  }
  return lines.join("\n") + "\n";
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Report whether the daemon, vault, browser, policy, and local files are in a safe state.")
    .option("--json", "Emit machine-readable JSON.", false)
    .action(async (options) => {
      const paths = getShuttlePaths();
      let socketMode: string | null = null;
      try {
        const st = await stat(paths.daemonSocketPath);
        socketMode = "0" + (st.mode & 0o777).toString(8);
      } catch { socketMode = null; }

      let health: Record<string, unknown> | null = null;
      let daemonError: string | null = null;
      try {
        health = (await daemonRequest("GET", "/v1/health")) as Record<string, unknown>;
      } catch (e) {
        daemonError = e instanceof Error ? e.message : String(e);
      }

      const report: DoctorReport = {
        daemon_reachable: health !== null,
        daemon_error: daemonError,
        socket_file_mode: socketMode,
        socket_file_mode_ok: socketMode === null || socketMode === "0600",
        health,
      };

      if (options.json === true) {
        outputJson(ok(report));
        return;
      }
      process.stdout.write(formatDoctorText(report));
    });
}
```

- [ ] **Step 4: Run the tests — they should now PASS**

Run:
```bash
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/cli/commands/doctor.test.js
```
Expected: all 4 tests pass.

- [ ] **Step 5: Smoke-test the doctor command end-to-end**

Run (with the daemon NOT running, so the agentic-flows line should not appear because `health` is null):
```bash
node dist/cli/index.js doctor
```
Expected: text output shows `daemon: NOT reachable` and no `agentic flows:` line.

Run with `--json` (also daemon-down):
```bash
node dist/cli/index.js doctor --json
```
Expected: JSON output with `daemon_reachable: false`, `health: null`.

- [ ] **Step 6: Commit Task 7**

Run:
```bash
git add src/cli/commands/doctor.ts src/cli/commands/doctor.test.ts
git commit -m "$(cat <<'EOF'
feat(doctor): agentic-flows availability line (spec §11)

`secret-shuttle doctor` now prints `agentic flows: available` or
`agentic flows: unavailable (start browser)` derived from
`health.agentic_browser.available`. Missing-field (older daemon) is treated
as unavailable (defensive default).

`doctor --json` exposes the same flag automatically via the existing health
echo. Refactored `formatDoctorText` into a pure exported function for unit
testing; the Commander action is now just stat + daemonRequest + write.
EOF
)"
```

---

### Task 8: Update `README.md` for-agents section + docs/cli-reference.md `agent` section

**Files:**
- Modify: `README.md`
- Modify: `docs/cli-reference.md`

> The README adds a one-line raw-URL paste instruction (per spec §10.2 final bullet) plus a short paragraph about the local installer. The cli-reference appends a new `## secret-shuttle agent install | print-skill-url` section. We also tweak the `## secret-shuttle doctor` paragraph to mention the new `agentic flows:` line.

- [ ] **Step 1: Read the current Quickstart section in README to find the insertion point**

Run:
```bash
grep -n "^## " README.md
```
Expected: lists section anchors including `## Install (from source)`, `## Quickstart`, `## Templates Instead of Arbitrary Commands`, `## What Works Today (0.1.1)`, etc.

- [ ] **Step 2: Insert the "For agents" section**

In `README.md`, insert a new `## For Agents` section immediately AFTER the `## Quickstart` section (i.e. just before `## Templates Instead of Arbitrary Commands`). Place the following block:

```markdown
## For Agents

If you're configuring an agent to use Secret Shuttle, paste this raw skill URL into the agent (it's the canonical operating manual):

```
https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md
```

If you have the CLI installed locally, run one of these from your project root and the platform-specific instructions file is written for you:

```bash
secret-shuttle agent install claude    # → .claude/skills/secret-shuttle/SKILL.md
secret-shuttle agent install codex     # → AGENTS.md snippet (marker-managed)
secret-shuttle agent install cursor    # → .cursor/rules/secret-shuttle.mdc
secret-shuttle agent install copilot   # → .github/copilot-instructions.md snippet (marker-managed)
secret-shuttle agent print-skill-url   # → the raw URL (one line, paste it)
```

Snippet targets (AGENTS.md, .github/copilot-instructions.md) wrap the Secret Shuttle block in `<!-- secret-shuttle:begin -->` / `<!-- secret-shuttle:end -->` markers — re-running `agent install` only replaces the marked block, never the surrounding content.
```

(Note: the inner code fence above uses three backticks for the URL block and three backticks for the bash block. When literally inserting into README.md, use real triple-backtick fences — the surrounding plan document uses these escapes only because it itself is a markdown file.)

- [ ] **Step 3: Add the skill to the README Docs list**

In `README.md` `## Docs` section (lines ~96-102), add a new bullet to the existing list:

```markdown
- [skills/secret-shuttle/SKILL.md](skills/secret-shuttle/SKILL.md) — the canonical agent operating manual
```

Place it as the first bullet (so it's the most visible entry an agent operator would see).

- [ ] **Step 4: Update `docs/cli-reference.md` doctor section**

In `docs/cli-reference.md`, find the existing `## secret-shuttle doctor` section (search via `grep -n "doctor" docs/cli-reference.md` — current content lives near the bottom). Append one paragraph to it:

```markdown
The `agentic flows:` line in the text output reports `available` when the daemon's browser is started AND the CDP proxy is active AND the daemon build supports handles (always true after Phases 1–3). When that line is `unavailable (start browser)`, run `secret-shuttle browser start` to enable the agentic browser flows (`inject-submit`, `reveal-capture`). The same flag is exposed under `health.agentic_browser.available` in `--json` mode.
```

- [ ] **Step 5: Append the new `secret-shuttle agent` section to `docs/cli-reference.md`**

At the end of `docs/cli-reference.md`, append:

```markdown
## `secret-shuttle agent install <claude|codex|cursor|copilot>`

Installs the canonical Secret Shuttle skill into the project's current working directory. Per target:

- `claude` → `.claude/skills/secret-shuttle/SKILL.md` (wholesale overwrite — Secret Shuttle owns this file).
- `codex` → `AGENTS.md` (marker-managed snippet between `<!-- secret-shuttle:begin -->` / `<!-- secret-shuttle:end -->`; preserves the rest of the file; re-running replaces only the marked block).
- `cursor` → `.cursor/rules/secret-shuttle.mdc` (wholesale overwrite).
- `copilot` → `.github/copilot-instructions.md` (marker-managed snippet, same convention as codex).

The skill content is the bundled `skills/secret-shuttle/SKILL.md` shipped with the package — installs do not hit the network. Writes are atomic (temp + rename) and idempotent (a second run with identical input produces a byte-identical file). The command operates exclusively on `process.cwd()`; it never writes to your home directory or any global path.

## `secret-shuttle agent print-skill-url`

Prints the raw GitHub URL of the canonical SKILL.md on one line of stdout, suitable for pasting into any agent that supports a remote skill URL. The URL is derived from the `repository` field in the shipped `package.json` (no hardcoded URLs — defense against fork/rename drift). Override the default `main` branch with `--branch <name>` or `--ref <name>`.
```

- [ ] **Step 6: Commit Task 8**

Run:
```bash
git add README.md docs/cli-reference.md
git commit -m "$(cat <<'EOF'
docs: For-Agents README section + agent CLI reference (spec §10.2)

README gains a "For Agents" section with the canonical raw skill URL + the
four agent install commands + the print-skill-url helper.

cli-reference.md gains:
  - a new ## secret-shuttle agent install ... section documenting each
    target's destination and write mode (wholesale vs marker snippet)
  - a new ## secret-shuttle agent print-skill-url section
  - one extra paragraph in the doctor section about the agentic-flows line
EOF
)"
```

---

### Task 9: Phase-5 e2e — agent install no-leak + idempotency under a real `process.cwd()` child

**Files:**
- Create: `src/e2e/agent-install-no-leak.test.ts`

> Phase-2/3 added `src/e2e/*` tests for the route flows; Phase 4 added a templates no-leak e2e. This Phase-5 e2e spawns the actual built `dist/cli/index.js` under a tmp dir CWD and verifies the four installs land at their spec'd paths with the correct write modes, plus that `print-skill-url` prints exactly the derived URL. It is the final check that the bundle-resolution paths in `readBundledSkill` / `readBundledPackageJson` actually work after `npm run build`.

- [ ] **Step 1: Write the failing e2e test**

Create `src/e2e/agent-install-no-leak.test.ts`:

```ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Resolve the built CLI relative to this test file's location.
// Build emits to dist/, and node --test runs tests from dist/, so:
//   __filename = dist/e2e/agent-install-no-leak.test.js
//   CLI       = dist/cli/index.js
const CLI = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "cli", "index.js");

const BEGIN = "<!-- secret-shuttle:begin -->";
const END = "<!-- secret-shuttle:end -->";

test("e2e: agent install writes each target's file to CWD with correct write mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ss-agent-e2e-"));

  // claude — wholesale
  let r = spawnSync("node", [CLI, "agent", "install", "claude"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install claude failed: ${r.stderr}`);
  const claudeFile = path.join(root, ".claude/skills/secret-shuttle/SKILL.md");
  const claudeContent = await readFile(claudeFile, "utf8");
  // The bundled SKILL.md begins with the canonical heading from Task 1.
  assert.ok(claudeContent.startsWith("# Secret Shuttle"), "claude install must write the canonical SKILL.md");

  // codex — snippet
  await writeFile(path.join(root, "AGENTS.md"), "USER-SENTINEL-BEFORE\n");
  r = spawnSync("node", [CLI, "agent", "install", "codex"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install codex failed: ${r.stderr}`);
  let agentsContent = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(agentsContent.includes("USER-SENTINEL-BEFORE"), "codex install must preserve pre-existing AGENTS.md content");
  assert.ok(agentsContent.includes(BEGIN), "codex install must write the begin marker");
  assert.ok(agentsContent.includes(END), "codex install must write the end marker");

  // codex idempotent — exactly one marked block after second run
  r = spawnSync("node", [CLI, "agent", "install", "codex"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install codex (2nd run) failed: ${r.stderr}`);
  agentsContent = await readFile(path.join(root, "AGENTS.md"), "utf8");
  const beginCount = (agentsContent.match(new RegExp(BEGIN.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
  const endCount = (agentsContent.match(new RegExp(END.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
  assert.equal(beginCount, 1, "exactly one begin marker after two installs");
  assert.equal(endCount, 1, "exactly one end marker after two installs");

  // cursor — wholesale
  r = spawnSync("node", [CLI, "agent", "install", "cursor"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install cursor failed: ${r.stderr}`);
  const cursorContent = await readFile(path.join(root, ".cursor/rules/secret-shuttle.mdc"), "utf8");
  assert.ok(cursorContent.startsWith("# Secret Shuttle"), "cursor install must write the canonical SKILL.md");

  // copilot — snippet
  r = spawnSync("node", [CLI, "agent", "install", "copilot"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install copilot failed: ${r.stderr}`);
  const copilotContent = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
  assert.ok(copilotContent.includes(BEGIN));
  assert.ok(copilotContent.includes(END));
});

test("e2e: agent install rejects an unknown target with a non-zero exit code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ss-agent-e2e-bad-"));
  const r = spawnSync("node", [CLI, "agent", "install", "atom"], { cwd: root, encoding: "utf8" });
  assert.notEqual(r.status, 0, "unknown target must fail with non-zero exit code");
  assert.match(r.stderr, /bad_request|must be one of/);
});

test("e2e: agent print-skill-url prints the derived URL on stdout (default branch=main)", async () => {
  const r = spawnSync("node", [CLI, "agent", "print-skill-url"], { encoding: "utf8" });
  assert.equal(r.status, 0, `agent print-skill-url failed: ${r.stderr}`);
  // The package.json shipped with this build has repository.url pointing at pdumicz/secret-shuttle.
  assert.match(r.stdout, /https:\/\/raw\.githubusercontent\.com\/[^\/]+\/secret-shuttle\/main\/skills\/secret-shuttle\/SKILL\.md/);
  // No JSON wrapper — exactly one URL line.
  assert.equal(r.stdout.trim().split("\n").length, 1, "print-skill-url emits exactly one URL line");
});

test("e2e: agent print-skill-url honors --branch override", async () => {
  const r = spawnSync("node", [CLI, "agent", "print-skill-url", "--branch", "feat/skill-installers"], { encoding: "utf8" });
  assert.equal(r.status, 0, `agent print-skill-url --branch failed: ${r.stderr}`);
  assert.match(r.stdout, /\/feat\/skill-installers\/skills\/secret-shuttle\/SKILL\.md/);
});
```

- [ ] **Step 2: Run the failing test**

Run:
```bash
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test dist/e2e/agent-install-no-leak.test.js
```
Expected: depending on whether all the previous tasks are committed, all 4 e2e tests pass. If they pass straight away (because Tasks 5/6/7 already wired everything correctly), that is the success case for this task. If anything fails, investigate the failure under "bundled file resolution" (most likely cause: the `readBundledSkill` candidate paths in `agent.ts` need adjustment for the actual dist layout — inspect `dist/cli/commands/agent.js`'s effective `import.meta.url` and tune the path math).

- [ ] **Step 3: Commit Task 9**

Run:
```bash
git add src/e2e/agent-install-no-leak.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): Phase-5 agent install + print-skill-url end-to-end (spec §13)

Spawns the built dist/cli/index.js as a child process under a tmp dir CWD,
verifies each target's destination + write mode + idempotency + the bad-target
error path + print-skill-url default + --branch override. The single check
that the bundled-file resolution math (readBundledSkill /
readBundledPackageJson) actually works against the real dist/ layout after
npm run build.
EOF
)"
```

---

### Task 10: Phase-5 verification + tag + finish-gate

**Files:**
- Modify: this plan's "## Self-Review" section (Step 4 below)
- Tag: `phase5-skill-installers-doctor-complete`

> Phase 5 has **no carried [P2a]/[P2b] release gate** (unlike Phases 2/3/4). The skill's per-provider production-vs-best-effort statement is correct-by-construction because it transcribes the gate-outcome text from the upstream Phase-2/3/4 plan files; if any of those are still PENDING when Phase 5 merges, the skill states PENDING (per the Scope section above). This final task runs the full suite, builds, typechecks, then tags the work for `main`-merge.

- [ ] **Step 1: Full typecheck**

Run:
```bash
npm run typecheck
```
Expected: clean exit code 0; no TypeScript errors.

- [ ] **Step 2: Full test suite**

Run:
```bash
npm test
```
Expected: all tests pass — including the new Phase-5 tests (skill-url.test.ts, agent-writer.test.ts, commands/agent.test.ts, commands/doctor.test.ts, daemon/api/routes.test.ts incl. the extended health tests + the e2e/agent-install-no-leak.test.ts) AND every preexisting test.

- [ ] **Step 3: Verify the npm pack contents**

Run:
```bash
npm run check-pack
```
Expected: `check-pack: OK (…) no forbidden paths/markers`. Verifies the tarball includes `skills/secret-shuttle/SKILL.md` and does NOT include `skills/claude-code/SKILL.md` (the path no longer exists). Also confirms `docs/superpowers/**` is excluded.

- [ ] **Step 4: Inspect the published file list once more**

Run:
```bash
npm pack --dry-run 2>&1 | grep -E "skills/|README|package.json" | head -20
```
Expected: lists `skills/secret-shuttle/SKILL.md`, `package.json`, `README.md`; no `skills/claude-code/*`.

- [ ] **Step 5: Verify the agent installs against the working tree as a smoke test**

Run from a fresh temp dir:
```bash
TMPCWD=$(mktemp -d)
cd "$TMPCWD"
node "$OLDPWD/dist/cli/index.js" agent install claude
node "$OLDPWD/dist/cli/index.js" agent install codex
node "$OLDPWD/dist/cli/index.js" agent install cursor
node "$OLDPWD/dist/cli/index.js" agent install copilot
node "$OLDPWD/dist/cli/index.js" agent print-skill-url
ls -laR
cd "$OLDPWD"
rm -rf "$TMPCWD"
```
Expected: four files exist at the four spec'd paths; `print-skill-url` prints exactly one line.

- [ ] **Step 6: Merge to main + tag**

This step follows the Phase 2/3/4 finish-gate pattern. The branch `feat/skill-installers` is now ready for fast-forward into `main`. From within the working tree:

Run:
```bash
git switch main
git merge --ff-only feat/skill-installers
git tag phase5-skill-installers-doctor-complete
git status --porcelain
```
Expected: clean ff-merge; the new tag exists; `git status --porcelain` is empty.

- [ ] **Step 7: Push (only if the user requests it — do NOT push without explicit instruction)**

Run (ONLY after user-confirmed push instruction):
```bash
git push origin main
git push origin phase5-skill-installers-doctor-complete
git branch -d feat/skill-installers
```
Expected: push succeeds; the feature branch is deleted locally; `origin/main` matches local `main`.

(Step 7 is gated on the user's explicit "push" instruction per the global git safety protocol.)

---

## [P5] Gate outcome

Phase 5 has **no manual release gate of its own**. The per-provider production-vs-best-effort statement in `skills/secret-shuttle/SKILL.md` + `README.md` honestly reflects the upstream [P2a]/[P2b] gate outcomes:

- Phase-2 Vercel [P2a] outcome: **PENDING** (the placeholder in the Phase-2 plan file's "## [P2a] Gate outcome" section was never filled in; the Vercel browser flow is currently documented as best-effort by default).
- Phase-3 Stripe [P2a] outcome: **PENDING (user-deferred)** — tracked as task #5 in the active task list ("Plan 3 Task 8: manual [P2a] Stripe real-page gate").
- Phase-4 templates [P2b] outcome: **PENDING** (placeholder in the Phase-4 plan file's "## [P2b] Gate outcome" section was never filled in).

When any of those three gates flips to PASS or BEST-EFFORT in its respective plan file, the canonical `skills/secret-shuttle/SKILL.md` + `README.md` "For Agents" section must be updated to match (one follow-up commit per gate flip). This plan does **not** forecast outcomes — it states the current PENDING reality, which is the safe default (everything documented as best-effort until proven otherwise).

---

## Self-Review (performed against the spec)

**1. Spec coverage:**

- §10.1 canonical skill — Task 1 (the seven directives, the `mark pick` choreography + concurrent-control fallback, the forbidden-actions block, the per-provider PENDING statement). The skill is agent-facing — written as imperative directives, not a human-facing tutorial.
- §10.1 retire `skills/claude-code/SKILL.md` — Task 1 (`git rm` + `package.json` `files` array update; defense-in-depth: the explicit `skills/secret-shuttle/SKILL.md` path replaces the broad `"skills"` blanket entry so a stray re-add of the deleted directory does not silently re-ship).
- §10.2 installers — Task 5 (`claude` → `.claude/skills/...` wholesale, `codex` → `AGENTS.md` snippet, `cursor` → `.cursor/rules/secret-shuttle.mdc` wholesale, `copilot` → `.github/copilot-instructions.md` snippet, `print-skill-url` derived from `repository.url`); all writes idempotent (Task 4 helpers); CWD-only (Task 5 + Task 9 e2e verifies); `package.json` gains the `repository` field (Task 2); the README "For Agents" section + the docs/cli-reference.md `agent` section (Task 8).
- §10.2 `print-skill-url` URL derivation — Task 3 (`deriveSkillUrl` pure helper); `--branch`/`--ref` overrides covered; the default `main` branch is encoded as the helper's default (no hardcoded constants in `agent.ts` beyond the path constant which is itself a default parameter of the helper); a fork to a non-github host throws fail-closed.
- §11 `/v1/health.agentic_browser` block — Task 6 (the five fields with the spec'd semantics; `available` = `browser_started && proxy_active && handles_supported`; `marks_active` is a count only — the no-leak test asserts labels/fingerprints/`backend_node_id` never appear in the response).
- §11 `doctor` agentic-flows line — Task 7 (text + `--json` exposure; text says "available" or "unavailable (start browser)"; missing-field defensive default).
- §14 phase-5 row + §15 acceptance — the skill + README per-provider statement (Task 1 + Task 8) honestly reports the PENDING gate outcomes; the "skill file is enough for Claude/Copilot/Codex" acceptance criterion (§15) is satisfied by the canonical SKILL.md being self-contained (all the directives, the `mark pick` choreography, the forbidden-actions block, the enum-response interpretation rules, the safe-output list).

**2. Architectural decisions documented inline:**

- Why retire `skills/claude-code/SKILL.md` cleanly (delete + remove from `files`) rather than redirect: the spec §10.1 says "retire" not "redirect"; a redirect note would (a) confuse agents that auto-discover skill files by globbing, (b) duplicate the canonical content under a misleading name, (c) drift if `skills/secret-shuttle/SKILL.md` is updated. The git history preserves the original; users who depended on the old path get a clean "404" on the next install, which is the desired loud signal.
- Why `marks_active` is a count and not a labels list: the spec §11 explicitly calls this out ("labels are non-secret but the count is sufficient for a health check and avoids any temptation to surface element context here"). The Task 6 no-leak test enforces it as a binding contract.
- Why `agentic_browser.available` doubles `browser_started`/`proxy_active` (which are also exposed at the top level): for back-compat — pre-Phase-5 consumers (the existing `doctor` text path) read the top-level fields; new consumers should branch on the capability block. Both are kept for the same response; the redundancy is one-shot.
- Why `print-skill-url` emits plain text (not the usual `outputJson(ok(…))` wrapper): the spec calls this "a one-line URL to paste into an agent" — JSON output forces the user to extract the value, defeating the purpose. The convention in this codebase has precedent: `init` and the other RPC commands use the JSON wrapper because they return structured data; `print-skill-url` is a single string + the unix convention is plain text for one-line output.
- Why the per-provider statement is "PENDING" rather than blank or absent: the §14 phase-5 row says the skill MUST state per provider whether the flow is production or best-effort "based on the Phase 2/3 P2a gate outcome". If the gate outcomes are PENDING, "PENDING" is the honest statement. Leaving the section blank would silently misrepresent (the agent would have no signal that the flow is unverified); claiming "production" would falsely overstate; claiming "best-effort" without the gate outcome would be defensible but lossy. "PENDING with explicit forward-pointer to the plan file's gate-outcome section" captures all three signals: "we haven't verified", "here's where the verification will be recorded", "treat as best-effort until then".
- Why the snippet writer treats begin-without-end as "lacks markers" (appends a new well-formed block, does NOT attempt repair): repair is unsafe — if a user manually deleted the end marker because they wanted to wipe the block, repair would silently reinstate it; if a script truncated the file mid-block, repair would invent a closing position that may bisect user content. The safe choice is "leave the orphan alone, append a new well-formed block, log nothing surprising". This matches the spec §10.2 invariant "writes are non-clobbering" — clobber-by-repair is still clobbering.

**3. Placeholder scan:**

- No `TODO`, `FIXME`, or `TBD` in the code or tests. Every code block in this plan is complete; every command has an `Expected:` line. The only "non-code" step is Task 1 Step 2's verbatim SKILL.md content, which IS the complete production skill (not a stub). The only fork in the road is Task 9 Step 2's contingency "If anything fails, investigate the failure under 'bundled file resolution'…" — this is the standard e2e-debugging branch, not an unfilled placeholder; the candidate paths in `readBundledSkill` cover the two plausible dist layouts.

**4. Type consistency:**

- `RepositoryField` shape in `skill-url.ts` matches npm's actual `package.json` shape (either a string or an object with `url`); the test covers both forms.
- `WriteAgentSnippetOpts` and `WriteAgentFileOpts` are independent types; neither leaks the other's fields.
- `DoctorReport` is exported from `doctor.ts` for the test + the formatter; the Commander action constructs a `DoctorReport` and passes it to `formatDoctorText`.
- The `agentic_browser` block in `/v1/health` matches the spec §11 JSON shape exactly: five fields, three booleans, one literal `true`, one integer. The test asserts the field types (`typeof ab === "object"`, etc.).

**5. Test-per-invariant matrix:**

| Invariant | Test |
|---|---|
| Installer writes are IDEMPOTENT (no observable change on 2nd run) | `agent-writer.test.ts` "writeAgentSnippet running twice with same content is byte-identical"; `agent.test.ts` "agentInstallTarget('codex') is idempotent"; `agent-install-no-leak.test.ts` "exactly one marked block after second run" |
| Snippet writes PRESERVE surrounding content | `agent-writer.test.ts` "writeAgentSnippet round-trip replaces ONLY the marked block" + "appends a new block when the existing file lacks markers"; `agent.test.ts` "preserves preexisting AGENTS.md content outside the block"; `agent-install-no-leak.test.ts` "must preserve pre-existing AGENTS.md content" |
| Full-file writes overwrite cleanly | `agent-writer.test.ts` "writeAgentFile overwrites an existing file wholesale"; `agent.test.ts` "agentInstallTarget('claude') is wholesale-overwrite" |
| `print-skill-url` URL DERIVED from `package.json` (no hardcoding) | `skill-url.test.ts` (9 tests); `agent.test.ts` "agentPrintSkillUrl returns the derived URL" + "honors --branch override"; `agent-install-no-leak.test.ts` "prints the derived URL" + "honors --branch override" |
| `/v1/health.agentic_browser.available` is FALSE when browser is not started OR proxy is not active | `routes.test.ts` (existing extended test — both fields false at base); a future test could add asymmetric cases (browser yes, proxy no — and vice versa). The TWO new tests cover the all-true case + the no-leak invariant. Adding two more asymmetric tests is a follow-up if anyone audits the binary `available = a && b && c` and wants belt-and-braces — but the three-flag AND is trivial enough that the binary cases (all-true vs at-least-one-false) cover the semantic. |
| `/v1/health.agentic_browser.marks_active` is a COUNT, never labels or DOM text | `routes.test.ts` new test "exposes ONLY counts — no labels, no fingerprints, no DOM text" |
| `doctor` agentic-flows line is consistent with the health JSON | `doctor.test.ts` 4 tests covering true/false/missing-field/null-health |
| The canonical SKILL.md does NOT misrepresent any provider's status | Task 1 Step 2 writes the verbatim PENDING statement; Task 9 e2e confirms the bundled file is installed verbatim |
| Retiring `skills/claude-code/SKILL.md` removes the file + its `package.json` ref + any other repo ref | Task 1 Step 3 (delete) + Step 4 (package.json update) + Step 5 (`git grep` confirms no remaining references in shipped files) |
| `agent install` operates on CWD only | `agent.test.ts` uses `process.chdir(root)`; `agent-install-no-leak.test.ts` uses `cwd: root` on spawnSync — both verify writes land under the temp root and never escape |

**6. Self-review iteration findings:**

- **Iteration 1 (3 findings patched):**
  - (P1) `readBundledSkill` originally had a single candidate path which would break in source-mode (`node --loader ts-node/esm src/cli/index.ts agent install …`). Fix: candidate-list with two layouts (dist + source), try each in order, throw fail-closed if neither resolves. Mirrors the Phase-2 `ui-server.ts` `HTML_PATH` resilience pattern.
  - (P2) The first draft of `formatDoctorText` did not handle `health === null`. Fix: guarded the line emission inside the `if (health !== null)` branch. The "missing field" case is then handled by the `ab !== undefined && ab.available === true` check inside that branch.
  - (P3) The first draft of the `package.json` files-array change replaced `"skills"` with `"skills/"` (trailing slash). Fix: npm `files` does NOT need the trailing slash; the more explicit `"skills/secret-shuttle/SKILL.md"` path is correct and ships only the canonical file, not the whole `skills/` tree (which is now empty post-retire).

- **Iteration 2 (2 findings patched):**
  - (P1) The first draft of `writeAgentSnippet` did not preserve the trailing newline structure when replacing the marked block — a second run produced `…\n\n` where the first run produced `…\n`. Fix: `const trailingNl = existing[afterEnd] === "\n" ? 1 : 0;` to consume the existing trailing newline after the end marker, then the new block always ends with `\n`. The idempotency test (`after1 === after2`) caught this.
  - (P2) The first draft of `agent.ts` hardcoded the markers as `BEGIN`/`END` constants but the spec wording says `<!-- secret-shuttle:begin -->` / `<!-- secret-shuttle:end -->` — confirmed the exact byte sequence (spec §10.2) is reflected in the constants.

**7. Cross-checks against the other phase plans:**

- File-structure section follows Phase 4 pattern (modify/create/delete bullets at the top, then tasks).
- Task numbering + size matches Phase 4 (10 tasks, each TDD-disciplined).
- The `## [P2a] Gate outcome` / `## [P2b] Gate outcome` precedent is mirrored by `## [P5] Gate outcome` — Phase 5 has no manual gate, so the section explicitly states "no manual release gate of its own" and points at the upstream PENDING gates.
- The "## Self-Review" section follows Phase 4's pattern (spec coverage + decisions + placeholder scan + type consistency + test-per-invariant matrix + iteration findings).
- Branching model: `feat/skill-installers` mirrors `feat/templates` from Phase 4.

**8. Decisions & open questions resolved:**

- *Retire claude-code skill — delete or redirect?* DELETE. The git history preserves the original; a redirect note would create maintenance burden and risk drift. Confirmed in Task 1.
- *Where exactly does `agentCommand()` go in `src/cli/index.ts`?* At the bottom of the `addCommand` block (after `doctorCommand()`), visible in code review; alphabetical-by-feature ordering is not currently enforced in this file so this matches the existing style.
- *`print-skill-url` plain text vs JSON?* Plain text. The use case is human-paste; JSON would be a hostile UX for the spec'd "paste one line" mode.
- *Snippet markers: HTML comments?* YES — `<!-- secret-shuttle:begin -->` / `<!-- secret-shuttle:end -->` are valid in both markdown and HTML; they render invisibly in both formats; they survive most markdown processors; they match the spec §10.2 verbatim text.
- *`agentic_browser.handles_supported` — when would this ever be false?* Only if a future daemon build ships without the `handles` store. Encoded as a literal `true` for current Phase-1-3 builds; a future degraded build can flip it false without changing the response shape.
- *`marks_active` — what if `services.handles` has expired entries?* `services.handles.list()` already prunes expired entries on access (see `browser-handles.ts:58-68`); the count is therefore "live, non-expired marks". Confirmed by reading the implementation.
- *Per-provider statement when gates are PENDING — claim production / claim best-effort / claim PENDING?* PENDING (with a forward pointer to the plan file's gate-outcome section). This is the honest signal; the alternative (claim best-effort by default) is defensible but lossier — "PENDING" tells the agent "we haven't verified this", which is strictly more informative.

---

## Done criteria

The plan is self-contained, exact (no TBD/TODO), TDD-disciplined, and faithful to spec §10 + §11 + §14 phase-5 row + §15. Each task is bite-sized; each step pairs a `Run:` command with an `Expected:` output line. Once written, this document is the executable plan for Phase 5.

After authoring this plan, commit it to `main` directly (this file is a dev artifact under `docs/superpowers/plans/`, never shipped — `check-pack.mjs` excludes the whole `docs/superpowers/**` tree from the npm tarball):

```bash
git add docs/superpowers/plans/2026-05-20-agentic-blind-transactions-phase5-skill-installers-doctor.md
git commit -m "$(cat <<'EOF'
docs: Phase 5 (skill + installers + doctor/health) implementation plan
EOF
)"
```

Then verify: branch is `main`; `git status --porcelain` is empty; `git rev-parse main` matches the new HEAD.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-20-agentic-blind-transactions-phase5-skill-installers-doctor.md`. This document fully specifies **Phase 5 (Agent Skill + Installers + doctor/health)** — the last phase of the agentic-blind-transactions design. No future plan is required; the design closes here. The per-provider production-vs-best-effort statement in the canonical SKILL.md + README honestly transcribes the current PENDING [P2a]/[P2b] gate outcomes from the Phase-2/3/4 plan files; when those gates are recorded as PASS or BEST-EFFORT, a follow-up commit updates the skill + README accordingly.
