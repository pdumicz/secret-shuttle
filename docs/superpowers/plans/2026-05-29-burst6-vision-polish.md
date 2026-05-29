# Burst 6 — Vision Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the discovery-surface fixes + `--infer` Supabase detector + README positioning + demo Scene 0 + dogfood template that close the gaps between v0.3.0 and "agent finds the repo → it works." Leaves the repo in publish-ready state as v0.3.1.

**Architecture:** All work lands on a `burst6/vision-polish` branch in a worktree at `.worktrees/burst6-vision-polish`. The §1 doc fixes + §3 README positioning + §4 demo scene + §5 dogfood template are pure documentation/HTML/CSS. The §2 Supabase detector is the only production-code change — it extends `runInfer` at `src/cli/provision/infer.ts` with a new per-secret `detectSupabaseForSecret` call that runs alongside the existing project-wide `detectDestinations`. Trust model unchanged. Each section commits independently; the wrap step bumps `package.json` to `0.3.1` and writes the CHANGELOG entry. The actual `npm publish` is gated on a post-burst user-driven dogfood run, NOT on burst-merge.

**Tech Stack:** TypeScript strict ESM (`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), Node built-in test runner (`node --test`), `node:fs/promises` for file I/O, `node:assert/strict`. Single-page HTML/CSS/JS for the demo. Markdown for all docs. Conventional Commits.

---

## Code-Grounding Corrections (read first)

These are verified facts about the current codebase that the engineer needs before touching any task. Each was confirmed via direct `Read` or `grep` against the v0.3.0 main branch (commit `b872b94`):

1. **The inference module lives at `src/cli/provision/infer.ts`** — NOT under `src/cli/bootstrap/`. The bootstrap directory holds only `destination-shorthand.ts` and `yml.ts`. Anywhere the spec references "the inference module" or "infer.ts", use the `src/cli/provision/` path.

2. **Existing detector shape is project-wide, returns `string[]`.** `detectDestinations(cwd: string): Promise<string[]>` at `src/cli/provision/infer.ts:105`. It's called ONCE at line 51, then the result is pushed onto every entry's `destinations` array at line 59. This is the architectural fact that makes the Supabase detector different — Supabase has to be per-secret because of the name predicate, while Vercel/Cloudflare/GitHub Actions stay project-wide.

3. **The `supabase:<scope>` shorthand ALREADY resolves correctly.** `src/cli/bootstrap/destination-shorthand.ts` has a `case "supabase":` block that maps `supabase:<scope>` → `template_id: "supabase-edge-secret-set"`, `template_params: { name: secretName, project_ref: scope }`. So the Supabase detector's output is just a shorthand string like `"supabase:abcdefghijklmnopqrst"` (where the scope IS the project_ref). No new template-resolver code needed.

4. **`package.json` `files` array** at lines 14-30 includes BOTH `"SKILL.md"` (top-level) AND `"skills/secret-shuttle/SKILL.md"`. Both ship to npm consumers today. Task 1.1 removes the first entry.

5. **Inference tests live at `src/cli/provision/infer.test.ts`** with the `mkdtemp` + `writeFile` pattern. Test fixtures use `import { runInfer } from "./infer.js"` (ESM `.js` extension).

6. **`InferGateIssue` is the existing `needs_edit` shape** — defined at `src/cli/provision/infer-gate.ts:31-34` as `{ secret: string; issue: string }` (NOT `{ kind; message }`). The Supabase detector therefore CANNOT emit `InferGateIssue` objects directly — its issues are not yet bound to a single secret name (override-validation issues span the whole batch) and carry a machine-readable `kind`. The Supabase detector emits its own additive `SupabaseDetectorIssue` type (`{ kind: string; message: string }`); the wiring step in `runInfer` (Task 2.3) maps each into the existing `{ secret, issue }` contract before merging into `InferResult.issues`. `InferGateIssue` itself is NOT modified — `isInferYmlExecutable` and the existing infer tests depend on its current shape. This is the "compatible additive contract" decision (see §2 Open-Question resolution below).

7. **No `secret-shuttle.config.json` loader exists yet.** Plan must introduce a minimal one — either inline in the Supabase detector, or as a small shared helper. Recommended: inline (no new config infrastructure for one optional field).

8. **No existing `e2e` drift-guard tests under `src/e2e/`** — but `src/e2e/agent-install-no-leak.test.ts` exists, so the directory is valid. New drift-guard tests go there.

9. **`agent-install-no-leak.test.ts` already asserts** the canonical SKILL content shape starts with `# Secret Shuttle`. This test will continue to pass after Task 1.1 deletes the top-level `SKILL.md` (it reads from `skills/secret-shuttle/SKILL.md`, not top-level).

10. **The demo file** is `demo/index.html`, ~1870 lines, self-contained HTML+CSS+JS. Scenes use `data-scene="N"` attributes. The scene-navigation function is JS in the same file. Read the file before §4 to confirm the exact selector + nav-function names.

11. **CHANGELOG.md "Unreleased" section** already contains the Burst 5 entries. The Burst 6 wrap adds a "Burst 6 — Vision Polish" subsection at the top of "Unreleased" (sibling of the existing "Burst 5" subsection).

12. **The repo's prevailing log pattern** is `console.warn(\`[secret-shuttle] ${msg}\`)`. The Supabase detector's debug/warning surface (if any) should match. The detector mostly emits `needs_edit` issues rather than console output.

13. **Strict TypeScript flags** `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are both on. Array indexing returns `T | undefined`. Optional fields use conditional spread (`...(x ? { foo: x } : {})`), not `foo: x ?? undefined`.

14. **All commits use Conventional Commits prefixes.** Recent main: `docs(spec): ...`, `docs(skill): ...`, `feat(audit): ...`, `fix(...): ...`, `test(...): ...`, `refactor(...): ...`, `chore: ...`.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `SKILL.md` (top-level) | **DELETE** | Stale duplicate of `skills/secret-shuttle/SKILL.md` |
| `package.json` | MODIFY | Remove top-level SKILL from `files` array (Task 1.1); bump version 0.3.0 → 0.3.1 (Wrap) |
| `src/e2e/skill-md-toplevel-absent.test.ts` | CREATE | Drift-guard: top-level `SKILL.md` must not exist |
| `src/e2e/docs-no-removed-verbs.test.ts` | CREATE | Drift-guard: agent-facing docs must not reference `secret-shuttle bootstrap` / `generate` / `daemon start && unlock` |
| `agents/AGENTS.md.example` | MODIFY | Setup ritual → `npx secret-shuttle init` |
| `agents/codex-instructions.example.md` | MODIFY | Replace `generate` examples with `provision --secret` |
| `agents/cursor-rules.example.md` | MODIFY | Replace `generate` references with `provision` |
| `examples/stripe-to-vercel/walkthrough.md` | MODIFY | Prepend Magic Path section; existing content moves under "Advanced: low-level mechanics" |
| `README.md` | MODIFY | Banner rewrite (0.1.1 → 0.3.1); positioning section between hero and Quickstart; demo URL update to `?scene=0` |
| `src/cli/provision/infer.ts` | MODIFY | Add per-secret Supabase invocation in the entries.map loop; accept optional inferConfig |
| `src/cli/provision/infer-supabase.ts` | CREATE | `detectSupabaseForSecret({ cwd, secretName, inferConfig })` + additive `SupabaseDetectorIssue` (`{ kind; message }`) type + helper for loading the optional config + `SUPABASE_NAME_PREDICATE_RE` + `SUPABASE_OVERRIDE_NAME_RE`. Does NOT modify `infer-gate.ts`. |
| `src/cli/provision/infer-supabase.test.ts` | CREATE | 7+ fixtures per spec §2.4 |
| `demo/index.html` | MODIFY | Prepend Scene 0 markup + CSS layout; add `?scene=N` query-param parsing |
| `docs/dogfood/burst6-template.md` | CREATE | Pre-populated friction-log skeleton for the post-burst user dogfood run |
| `CHANGELOG.md` | MODIFY | Add "Burst 6 — Vision Polish" subsection under "Unreleased" |

---

## Pre-flight (run once before Task 1.1)

- [ ] **Step 0.1: Confirm starting state**

Run:
```bash
cd /Users/patrykdumicz/Desktop/Codebases/secret-shuttle
git status
git log --oneline -3
```
Expected: clean working tree on `main` at commit `b872b94 docs(spec): Burst 6 — codex spec-gate revisions (rounds 1-5)`.

- [ ] **Step 0.2: Create the worktree + branch**

```bash
cd /Users/patrykdumicz/Desktop/Codebases/secret-shuttle
git worktree add .worktrees/burst6-vision-polish -b burst6/vision-polish
cd .worktrees/burst6-vision-polish
git status
```
Expected: new branch `burst6/vision-polish` on a fresh worktree. All subsequent task work happens inside `.worktrees/burst6-vision-polish/`.

- [ ] **Step 0.3: Verify baseline tests pass on the worktree**

```bash
npm test 2>&1 | tail -10
```
Expected: 1568 pass / 0 fail / 18 skip (the v0.3.0 baseline).

---

## §1 — Documentation drift fixes

### Task 1.1: Delete top-level `SKILL.md` + drift guard + remove from `package.json` files whitelist

**Files:**
- Delete: `SKILL.md` (top-level, repo-root)
- Modify: `package.json` (files array)
- Create: `src/e2e/skill-md-toplevel-absent.test.ts`

- [ ] **Step 1.1.1: Confirm the file ships**

Run:
```bash
grep -n '"SKILL.md"' package.json
ls -la SKILL.md
```
Expected: `package.json` contains `"SKILL.md",` line in the `files` array; top-level `SKILL.md` exists.

- [ ] **Step 1.1.2: Write the failing drift-guard test**

Create `src/e2e/skill-md-toplevel-absent.test.ts`:
```ts
// src/e2e/skill-md-toplevel-absent.test.ts
//
// Burst 6 §1.1 drift-guard. The canonical agent skill lives at
// skills/secret-shuttle/SKILL.md (the in-skills/ copy). A top-level
// SKILL.md in this repo would ship to npm consumers alongside the
// canonical copy and could drift — e.g., the Burst 5 §3 restructure
// only updated the in-skills/ copy, so the deleted top-level still
// referenced the removed `bootstrap` verb until §1.1 of Burst 6
// removed it. This test prevents accidental re-introduction.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("top-level SKILL.md must not exist (canonical skill is at skills/secret-shuttle/SKILL.md)", () => {
  const path = join(process.cwd(), "SKILL.md");
  assert.equal(
    existsSync(path),
    false,
    "Top-level SKILL.md re-introduced. Delete it; the canonical skill is at skills/secret-shuttle/SKILL.md. See Burst 6 §1.1.",
  );
});
```

- [ ] **Step 1.1.3: Run the test, verify it FAILS**

Run: `npm test -- --test-name-pattern "top-level SKILL.md"`
Expected: FAIL — assertion message names `SKILL.md` re-introduction. This is the TDD red.

- [ ] **Step 1.1.4: Delete the top-level SKILL.md**

Run:
```bash
git rm SKILL.md
```
Expected: file removed from working tree, staged for commit.

- [ ] **Step 1.1.5: Remove the entry from `package.json` files whitelist**

Read `package.json` to find the exact line:
```bash
grep -n '"SKILL.md"' package.json
```
Open `package.json` and remove the line `    "SKILL.md",` from inside the `"files": [ ... ]` array (between line ~21 and ~22 today). Keep `"skills/secret-shuttle/SKILL.md"`.

- [ ] **Step 1.1.6: Re-run the test, verify it PASSES**

```bash
npm test -- --test-name-pattern "top-level SKILL.md"
```
Expected: PASS.

- [ ] **Step 1.1.7: Verify nothing else broke**

```bash
npm test 2>&1 | tail -10
npx tsc --noEmit
npm run check-pack 2>&1 | tail -10
```
Expected: full suite still passes (1569 / 0 / 18 — one new test); typecheck clean; `check-pack` returns `OK (180 files, no forbidden paths/markers)` — note the file count drops by 1 because top-level SKILL.md no longer ships.

- [ ] **Step 1.1.8: Commit**

```bash
git add SKILL.md package.json src/e2e/skill-md-toplevel-absent.test.ts
git commit -m "$(cat <<'EOF'
chore(skill): delete stale top-level SKILL.md (drift-guard)

The Burst 5 §3 restructure only updated the in-skills/ copy. The
top-level SKILL.md ship-by-default still carried the removed
\`bootstrap\` verb in its quickstart. The canonical agent skill is
\`skills/secret-shuttle/SKILL.md\`; the top-level duplicate has no
purpose and was a maintenance hazard.

- Delete \`SKILL.md\` (top-level).
- Remove \`"SKILL.md"\` from \`package.json\` \`files\` whitelist.
- Add \`src/e2e/skill-md-toplevel-absent.test.ts\` drift-guard so the
  file cannot be silently re-introduced.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit lands on `burst6/vision-polish`.

---

### Task 1.2: Refresh `agents/AGENTS.md.example`

**Files:**
- Modify: `agents/AGENTS.md.example`

- [ ] **Step 1.2.1: Read the current file**

Run: `cat agents/AGENTS.md.example | head -30`

Expected: the setup block uses `secret-shuttle daemon start && secret-shuttle unlock` on the first two non-header lines.

- [ ] **Step 1.2.2: Rewrite the setup block**

Use Edit tool to replace:
```
secret-shuttle daemon start && secret-shuttle unlock
```
With:
```
npx secret-shuttle init
```

And replace the surrounding paragraph (likely "Run these before the first secret operation. `unlock` opens a local web window for the passphrase.") with:
```
Run this once per project. `init` spawns the daemon, walks the user through setting a vault passphrase via a local browser window (the CLI never reads the passphrase), and auto-installs this agent's canonical skill file. After `init` succeeds the agent is ready to use the Burst 5+ verb surface (`provision`, `secrets list`, `audit`, etc.).
```

Keep every other section verbatim — especially the security-rules section (`Never ask the user to paste raw secrets`, `Use refs like ss://stripe/prod/STRIPE_WEBHOOK_SECRET`, blind-mode discipline). Those are still correct.

- [ ] **Step 1.2.3: Verify the file**

Run:
```bash
grep -n "daemon start &&\|secret-shuttle generate\|secret-shuttle bootstrap" agents/AGENTS.md.example
```
Expected: no matches.

- [ ] **Step 1.2.4: Commit**

```bash
git add agents/AGENTS.md.example
git commit -m "docs(agents): refresh AGENTS.md.example to use \`npx secret-shuttle init\`"
```

---

### Task 1.3: Refresh `agents/codex-instructions.example.md`

**Files:**
- Modify: `agents/codex-instructions.example.md`

- [ ] **Step 1.3.1: Locate the stale lines**

Run: `grep -n "secret-shuttle generate\|secret-shuttle bootstrap\|daemon start" agents/codex-instructions.example.md`

Expected: at least one match referencing `secret-shuttle generate --name X --env prod --kind random_32_bytes --allow-domain vercel.com` (per the spec).

- [ ] **Step 1.3.2: Rewrite the generate example**

Use Edit tool to replace the `secret-shuttle generate ...` block with the canonical Burst 5 flow. The exact replacement (multi-line; preserve indentation):

```bash
secret-shuttle provision --secret INTERNAL_CRON_SECRET \
  --from random_32_bytes \
  --environment production \
  --to vercel:production
```

Also audit the rest of the file for other stale flags. Common shapes to check:
- `secret-shuttle generate` → `secret-shuttle provision --secret`
- `secret-shuttle bootstrap` → `secret-shuttle provision`
- `--allow-domain X` (legacy) → drop; allow-domains is computed from `--to` destinations now
- `--name X` → `--secret X`
- `--env X` → `--environment X`
- `--kind X` → `--from X`

- [ ] **Step 1.3.3: Verify**

Run:
```bash
grep -n "secret-shuttle generate\|secret-shuttle bootstrap\|daemon start &&\|--allow-domain" agents/codex-instructions.example.md
```
Expected: no matches.

- [ ] **Step 1.3.4: Commit**

```bash
git add agents/codex-instructions.example.md
git commit -m "docs(agents): refresh codex-instructions.example.md to use \`provision\` (Burst 5 surface)"
```

---

### Task 1.4: Refresh `agents/cursor-rules.example.md`

**Files:**
- Modify: `agents/cursor-rules.example.md`

- [ ] **Step 1.4.1: Locate stale lines**

Run: `grep -n "secret-shuttle generate\|secret-shuttle bootstrap" agents/cursor-rules.example.md`

Expected: at least two matches (per spec note about `cursor-rules.example.md:8` and `:30`).

- [ ] **Step 1.4.2: Rewrite the references**

Same transformation table as Task 1.3:
- `secret-shuttle generate` → `secret-shuttle provision --secret`
- `secret-shuttle bootstrap` → `secret-shuttle provision`
- Drop `--allow-domain` references (computed from `--to`)
- `--name` → `--secret`, `--env` → `--environment`, `--kind` → `--from`

The Cursor rules file is shorter than codex-instructions; one Edit call should suffice. Preserve the file's section structure (Cursor `.mdc` rules have a YAML frontmatter — leave it alone).

- [ ] **Step 1.4.3: Verify**

Run:
```bash
grep -n "secret-shuttle generate\|secret-shuttle bootstrap" agents/cursor-rules.example.md
```
Expected: no matches.

- [ ] **Step 1.4.4: Commit**

```bash
git add agents/cursor-rules.example.md
git commit -m "docs(agents): refresh cursor-rules.example.md to use \`provision\` (Burst 5 surface)"
```

---

### Task 1.5: `examples/stripe-to-vercel/walkthrough.md` magic-path rewrite

**Files:**
- Modify: `examples/stripe-to-vercel/walkthrough.md`

- [ ] **Step 1.5.1: Read the current file shape**

```bash
wc -l examples/stripe-to-vercel/walkthrough.md
head -40 examples/stripe-to-vercel/walkthrough.md
```

Take notes on:
- The current top-of-file heading (likely `# Stripe → Vercel walkthrough` or similar)
- The existing first command (which the spec confirms is one of `secret-shuttle daemon start`, `browser start`, or `blind start`)

- [ ] **Step 1.5.2: Insert "Magic path" section at the top**

After the existing `# <title>` heading (or `# Stripe → Vercel ...`) and before the first existing command block, insert:

```markdown
## Magic path

The fastest way to ship a Stripe webhook secret to Vercel production:

```bash
secret-shuttle provision \
  --secret STRIPE_WEBHOOK_SECRET \
  --from capture --url https://dashboard.stripe.com/webhooks \
  --to vercel:production
```

Secret Shuttle responds with `approval_required` — the local hub opens
showing one approval card. Click **Approve** (optionally check "Also
approve any matching shape for the next 15 min" if you'll be re-pushing
soon). Then the agent runs the continue step:

```bash
secret-shuttle provision --continue \
  --batch <batch_id_from_prior_step> \
  --approval-id <approval_id_from_prior_step>
```

The CLI navigates to Stripe in a daemon-owned browser, asks you to
reveal the webhook signing secret, captures the bytes into the vault
without exposing them to the agent, and pushes them to Vercel via the
`vercel-env-add` template. Final output:

```json
{
  "ok": true,
  "batch_status": "completed",
  "completed": 1,
  "refs": ["ss://stripe/prod/STRIPE_WEBHOOK_SECRET"]
}
```

Then the agent runs `secret-shuttle audit --since 1m --json` and pastes
the result to the user as proof.

---

## Advanced: low-level mechanics

The rest of this walkthrough covers the underlying primitives —
`browser start`, `blind start`, `capture`, `inject`, `template run`.
You don't need them for the magic path above; they're the escape hatch
when you need to debug a capture flow step-by-step.
```

Then the existing low-level content follows verbatim (the `## Advanced: low-level mechanics` header above this comment is the boundary).

Use Edit tool to find the existing first content block (between `# <title>` and the first `secret-shuttle <verb>` command) and insert the Magic Path section after the title. The "Advanced: low-level mechanics" header line above the existing low-level content is part of the insertion.

- [ ] **Step 1.5.3: Verify the file structure**

Run:
```bash
grep -n "^## " examples/stripe-to-vercel/walkthrough.md
```
Expected: at least these section headers appear in order:
1. `## Magic path` (new)
2. `## Advanced: low-level mechanics` (new boundary)
3. Whatever existing `## <existing-section>` headers there were

Also run:
```bash
grep -n "secret-shuttle provision --secret\|secret-shuttle provision --continue" examples/stripe-to-vercel/walkthrough.md
```
Expected: at least 2 matches (one each).

- [ ] **Step 1.5.4: Commit**

```bash
git add examples/stripe-to-vercel/walkthrough.md
git commit -m "$(cat <<'EOF'
docs(example): walkthrough leads with provision-magic path; low-level moves under "Advanced"

Burst 6 §1.5. The existing low-level capture/inject ritual still works
and is documented under the new "Advanced: low-level mechanics" header —
but the page now opens with the Burst-5 magic flow:
\`provision --secret ... --from capture --url ... --to vercel:production\`,
one approval click, \`provision --continue\`, \`audit --since 1m --json\`.

Users hitting this page from the README now see the headline pattern
before the escape-hatch verbs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.6: README header banner rewrite

**Files:**
- Modify: `README.md`

Note: this task lands ALONGSIDE Task 3.1 (positioning section) in a single combined commit, because both touch `README.md` and changing them in two separate commits creates a flaky intermediate state.

**Version-string coupling (spec §1.6):** the README banner must NOT advertise `0.3.1` before `package.json` is bumped to `0.3.1`, or there is an intermediate commit range where the README claims a version `npm view` cannot resolve. So this task writes a **version-neutral** banner (no version number — just the "beta, six bursts of review" framing). The `0.3.1` version string is injected into the banner by Task W.2 (Step W.2.1b) in the SAME commit as the `package.json` bump, so README and package version flip together.

- [ ] **Step 1.6.1: Locate the existing status banner**

Run: `grep -n "Status: 0.1.1\|early prototype" README.md`

Expected: a line near the top reading `> **Status: 0.1.1 — early prototype. Do not trust this with real production secrets yet.**` followed by a longer paragraph.

- [ ] **Step 1.6.2: Replace the banner (version-neutral)**

Use Edit to replace the two-paragraph banner block. New content — NO version number (W.2 injects `0.3.1` in lockstep with the package bump):

```markdown
> **Status: beta.** The architecture has been through six bursts of adversarial security review with fixes shipped at each gate. Not yet independently audited; recommend test accounts and rotating tokens until that audit lands. Suitable for development workflows and prototype deployments.
```

(One-paragraph block, replacing the existing two-paragraph block. Keep the `>` blockquote prefix. Deliberately omits the `0.3.1` version string — see the version-string-coupling note above; Task W.2 adds it.)

- [ ] **Step 1.6.3: Verify**

Run:
```bash
grep -n "Status:" README.md
grep -n "early prototype" README.md
grep -n "0\.3\.1" README.md
```
Expected: the first grep matches `Status: beta.`; the second grep returns no matches; the third grep returns NO matches yet (the version string lands in W.2 alongside the package bump).

- [ ] **Step 1.6.4: Do NOT commit yet** — bundle with Task 3.1.

---

### Task 1.7: Removed-verb drift-guard test (`docs-no-removed-verbs`)

**Files:**
- Create: `src/e2e/docs-no-removed-verbs.test.ts`

This test fires AFTER Tasks 1.2-1.5 land, so it can pass on the freshly-cleaned docs.

- [ ] **Step 1.7.1: Write the test**

Create `src/e2e/docs-no-removed-verbs.test.ts`:
```ts
// src/e2e/docs-no-removed-verbs.test.ts
//
// Burst 6 §1.7 drift-guard. Burst 5 removed the `bootstrap` and `generate`
// verbs, and renamed the setup ritual from `daemon start && unlock` to
// `npx init`. The agent-facing documentation surfaces (the canonical
// SKILL.md, all agents/*.example.md, the magic-path walkthrough, and the
// README) must not silently regress to reference the removed verbs.
//
// IMPORTANT — what is and is NOT allowlisted (spec §1.7):
// The walkthrough's "Advanced: low-level mechanics" section intentionally
// preserves the canonical *escape-hatch* verbs `blind start`, `capture`,
// `inject`, `template run`. Those verbs are NOT in REMOVED_TOKENS below, so
// they pass this guard everywhere by construction — no per-section allowlist
// is needed for them. The REMOVED verbs (`generate`, `bootstrap`, the
// `daemon start && unlock` ritual) must NEVER be allowlisted, including below
// that header. Therefore this test scans every line of every doc with NO
// section exemption: removed tokens are forbidden everywhere, escape-hatch
// tokens are allowed everywhere. (An earlier draft skipped all scanning below
// the "Advanced" header, which would have let a removed verb slip through in
// exactly the section the burst is meant to keep honest — that exemption is
// deliberately gone.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Spec §1.7 freezes the contract as the *glob* `agents/*.example.md`, not a
// frozen list. Enumerate the directory at collection time (readdirSync keeps
// the `for`-loop test registration synchronous) so any NEW agent example added
// later is covered by this drift guard automatically — a hardcoded list would
// silently exempt future surfaces, defeating the guard. Matches both
// `*.example.md` (e.g. codex-instructions.example.md) and the `AGENTS.md.example`
// naming variant by requiring the `example` + `md` tokens in either order.
const AGENT_DOCS: string[] = readdirSync(join(process.cwd(), "agents"))
  .filter((f) => /\.example\.md$/.test(f) || /\.md\.example$/.test(f))
  .sort()
  .map((f) => join("agents", f));

const DOCS: string[] = [
  "skills/secret-shuttle/SKILL.md",
  ...AGENT_DOCS,
  "README.md",
  "examples/stripe-to-vercel/walkthrough.md",
];

const REMOVED_TOKENS: Array<{ token: RegExp; what: string }> = [
  { token: /secret-shuttle\s+generate\b/, what: "removed `generate` verb (use `provision --secret`)" },
  { token: /secret-shuttle\s+bootstrap\b/, what: "removed `bootstrap` verb (use `provision`)" },
  { token: /daemon\s+start\s*&&\s*secret-shuttle\s+unlock/, what: "removed `daemon start && unlock` ritual (use `npx secret-shuttle init`)" },
  // Looser `daemon start &&` catches variants that drop the explicit `secret-shuttle unlock`.
  { token: /daemon\s+start\s*&&\s*(?!\s*[\r\n])/, what: "removed `daemon start && ...` ritual (use `npx secret-shuttle init`)" },
];

for (const path of DOCS) {
  test(`drift-guard: ${path} contains no removed-verb tokens`, async () => {
    const fullText = await readFile(join(process.cwd(), path), "utf8");
    const lines = fullText.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const { token, what } of REMOVED_TOKENS) {
        if (token.test(line)) {
          assert.fail(
            `${path}:${i + 1} contains ${what}\n  Line: ${line.trim()}\n  ` +
              `Burst 5/6 removed this verb. See docs/superpowers/specs/2026-05-29-burst6-vision-polish-design.md §1.`,
          );
        }
      }
    }
  });
}
```

> **Note on the escape-hatch verbs:** because `blind start`, `capture`, `inject`, and `template run` are deliberately absent from `REMOVED_TOKENS`, the walkthrough's "Advanced: low-level mechanics" section passes this guard without any section-scoped allowlist. The guard is strictly about the three *removed* surfaces. If a future change removes one of the escape-hatch verbs too, add it to `REMOVED_TOKENS` AND delete the corresponding references from the walkthrough — never re-introduce a below-header exemption.

- [ ] **Step 1.7.2: Run the test, verify it PASSES**

(It should pass because Tasks 1.2-1.5 already removed the offending tokens.)

```bash
npm test -- --test-name-pattern "drift-guard: " 2>&1 | tail -15
```
Expected: one PASS per doc (6 today — the canonical SKILL.md, the README, the walkthrough, and the three current `agents/*.example.md`; the agent count tracks the directory, so adding a new example raises this number automatically), 0 FAIL.

- [ ] **Step 1.7.3: Commit**

```bash
git add src/e2e/docs-no-removed-verbs.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): drift-guard for removed-verb leakage in agent-facing docs

Burst 6 §1.7. Burst 5 removed \`bootstrap\` + \`generate\` verbs and
renamed the setup ritual from \`daemon start && unlock\` to
\`npx secret-shuttle init\`. The agent-facing docs (canonical SKILL.md,
agents/*.example.md, walkthrough, README) regressed at least once
between bursts; this guard prevents silent re-introduction.

The guard scans every line of every doc with no section exemption:
removed verbs are forbidden everywhere. The canonical escape-hatch
verbs (\`blind start\`, \`capture\`, \`inject\`, \`template run\`) are
simply absent from the removed-token list, so the walkthrough's
"Advanced: low-level mechanics" section passes by construction — no
below-header allowlist (which could have let a removed verb slip
through that very section).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## §3 — README positioning section (lands with §1.6 banner rewrite)

### Task 3.1: Insert "Why not Doppler / Infisical / 1Password CLI / Vercel envs?" section

**Files:**
- Modify: `README.md`

This task assumes Task 1.6 has already rewritten the banner (in-progress, not yet committed). Both edits commit together at the end of this task.

- [ ] **Step 3.1.1: Find the insertion point**

Run:
```bash
grep -n "^## 30-Second Install\|^# Secret Shuttle\|Let AI agents" README.md
```
Expected: the hero ("Let AI agents use secrets without seeing them") is near the top, followed by a status banner, followed by the demo embed, followed by `## 30-Second Install`. The positioning section goes BETWEEN the demo embed and `## 30-Second Install`.

- [ ] **Step 3.1.2: Insert the positioning section**

Use Edit to insert the following block immediately above the `## 30-Second Install` heading:

```markdown
## Why not Doppler / Infisical / 1Password CLI / Vercel envs?

Those tools sync secrets across environments — they assume a human or a CI runner is
the consumer. Secret Shuttle assumes an AI coding agent is the consumer, and treats
every plaintext touch as a leak vector.

| Tool                  | Where secrets live    | Who sees plaintext                                | Agent-aware?           |
|---                    |---                    |---                                                |---                     |
| Doppler / Infisical   | Cloud vault           | Anyone with read access (incl. agents querying it)| No — sync model        |
| 1Password CLI         | OS keychain           | Caller process; `op read` writes to stdout        | No                     |
| Vercel envs (et al.)  | Vendor backend        | Engineers via dashboard; build runners via env    | No                     |
| **Secret Shuttle**    | Local daemon vault    | Only the daemon's child processes (templates)     | **Yes** — agent sees only refs |

If your secrets already live in a sync tool and an agent never touches them, you don't
need Secret Shuttle. If you have an agent writing code that needs to ship secrets to
Vercel/GitHub/etc, and you want the agent to do that without the bytes entering its
context — that's the gap this closes.

```

(Trailing blank line is intentional — keeps the gap between this section and the `## 30-Second Install` header.)

- [ ] **Step 3.1.3: Verify the README**

Run:
```bash
grep -n "^## " README.md | head -10
```
Expected order of `## ` headers near the top:
1. `## Why not Doppler / Infisical / 1Password CLI / Vercel envs?` (new)
2. `## 30-Second Install` (existing)
3. (other existing headers...)

Also run:
```bash
npm test -- --test-name-pattern "drift-guard: README"
```
Expected: still passes (the positioning text doesn't introduce any removed-verb tokens).

- [ ] **Step 3.1.4: Commit Tasks 1.6 + 3.1 together**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): rewrite 0.1.1 prototype banner + add positioning section

Burst 6 §1.6 + §3. Two changes to README.md that both shipped together
because they share the file:

- Banner: "Status: 0.1.1 — early prototype. Do not trust this with
  real production secrets yet." → "Status: beta. ..." (honest framing
  of where the project actually is post-6-bursts of adversarial
  review). Deliberately version-NEUTRAL here: the `0.3.1` version
  string is injected by the wrap step (W.2) in the SAME commit as the
  package.json bump, so the README never advertises a version newer
  than npm view will resolve.
- Positioning: "Why not Doppler / Infisical / 1Password CLI / Vercel
  envs?" 4-row comparison table inserted between the demo embed and
  the 30-Second Install section. Answers "what's different about
  this?" in a way the vibe coder can show their lead engineer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## §2 — `--infer` Supabase detector

### Open-Question resolution: how config-level Supabase issues are represented

Codex's plan-gate raised: *"Should config-level Supabase issues be represented as a synthetic `secret` issue, or should the infer issue type be intentionally extended?"* **Decision (frozen for implementation): neither — use a compatible additive contract.**

- The existing `InferGateIssue` is `{ secret: string; issue: string }` (`infer-gate.ts:31-34`) and is consumed by `isInferYmlExecutable` plus the existing infer tests. It is **left unchanged** — no field additions, no `kind` union.
- The Supabase detector defines its own additive `SupabaseDetectorIssue` type (`{ kind: string; message: string }`) in `infer-supabase.ts`. The `kind` gives the detector a machine-readable discriminant; the detector's override-validation issues are not naturally bound to a single secret, so the detector's own type fits them better than the gate's per-secret shape.
- The Task 2.3 wiring **maps** each `SupabaseDetectorIssue` into the existing `{ secret, issue }` contract before merging into `InferResult.issues` — the originating secret name fills `secret`, and the `kind` is folded into the `issue` string as a `[kind]` prefix so nothing is lost. Override-validation issues (batch-wide) attach to the first secret that surfaced them, after dedupe.

This keeps `InferResult.issues` a single homogeneous `InferGateIssue[]` for every existing consumer (no synthetic second issue type leaking out), while giving the detector a clean internal contract. It is the "explicitly design a compatible additive contract" path — chosen over extending `InferGateIssue` (would ripple into `isInferYmlExecutable` + its tests) and over a raw synthetic issue (would lose the machine-readable `kind`).

### Task 2.1: Scout existing infer module + write failing fixture (a)

**Files:**
- Read: `src/cli/provision/infer.ts`, `src/cli/provision/infer-gate.ts`, `src/cli/provision/infer.test.ts`
- Create: `src/cli/provision/infer-supabase.test.ts`

- [ ] **Step 2.1.1: Read the existing infer module top-to-bottom**

```bash
cat src/cli/provision/infer.ts
```
Confirm what's documented in Code-Grounding fact #2: `detectDestinations(cwd)` returns `string[]`; called once at line ~51; pushed onto every entry at line ~59.

- [ ] **Step 2.1.2: Read `InferGateIssue` shape**

```bash
cat src/cli/provision/infer-gate.ts
```
Confirm the existing `InferGateIssue` shape is `{ secret: string; issue: string }` (Code-Grounding fact #6). Your Supabase detector does NOT emit `InferGateIssue` directly — it emits its own `SupabaseDetectorIssue` (`{ kind; message }`), and the Task 2.3 wiring maps it into `{ secret, issue }` before merging into `InferResult.issues`. Do not modify `infer-gate.ts`.

- [ ] **Step 2.1.3: Write the first failing test (fixture a)**

Create `src/cli/provision/infer-supabase.test.ts`:
```ts
// src/cli/provision/infer-supabase.test.ts
//
// Burst 6 §2 tests for the Supabase per-secret detector.
// Spec §2.4 enumerates the fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSupabaseForSecret } from "./infer-supabase.js";

async function setupTmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ss-infer-supabase-test-"));
}

test("(a) linked project + SUPABASE_ name → emits supabase destination with project_ref", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst", name: "my-project" }),
    );

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_SERVICE_ROLE_KEY",
      inferConfig: null,
    });

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.1.4: Run test, verify it FAILS**

```bash
npm test -- --test-name-pattern "supabase" 2>&1 | tail -10
```
Expected: FAIL because `detectSupabaseForSecret` and `./infer-supabase.js` don't exist yet. TypeScript may also fail to compile — that's also a valid red.

---

### Task 2.2: Implement `detectSupabaseForSecret`

**Files:**
- Create: `src/cli/provision/infer-supabase.ts`

- [ ] **Step 2.2.1: Write the detector**

Create `src/cli/provision/infer-supabase.ts`:
```ts
/**
 * Burst 6 §2 — Supabase detector for `provision --infer`.
 *
 * Per-secret detector (unlike the project-wide Vercel/Cloudflare/
 * GitHub Actions detectors in infer.ts). Evaluates a name predicate
 * first; only secrets matching the predicate get a Supabase destination,
 * even when `supabase/config.toml` is present. Prevents over-routing
 * Stripe/cron/other secrets onto Supabase.
 *
 * The cloud `project_ref` (used by `supabase-edge-secret-set`) lives in
 * `.supabase/project.json`'s `ref` field, written by `supabase link
 * --project-ref <ref>`. Without that file, the detector emits a
 * needs_edit message rather than a broken destination.
 *
 * See spec §2 and Burst 6 plan Task 2.2 for the full design rationale.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Additive issue contract for the Supabase detector. This is DISTINCT from
 * `InferGateIssue` (`{ secret; issue }` in infer-gate.ts) for two reasons:
 *   1. Detector issues carry a machine-readable `kind` (the gate's issues
 *      do not).
 *   2. Override-validation issues are NOT bound to a single secret name —
 *      they describe the whole `secret-shuttle.config.json` override — so
 *      they don't fit the gate's per-secret `{ secret }` field.
 * The wiring in runInfer (Task 2.3) maps each SupabaseDetectorIssue into the
 * existing `{ secret, issue }` InferGateIssue shape before merging into
 * `InferResult.issues`. `InferGateIssue` itself is left unchanged.
 */
export interface SupabaseDetectorIssue {
  /** Machine-readable discriminant: "supabase_not_linked" |
   *  "supabase_inferconfig_invalid". */
  kind: string;
  /** Human-readable needs_edit message. */
  message: string;
}

/** Default name predicate — secret names matching this regex automatically
 *  route to Supabase when a Supabase project is detected on disk. */
export const SUPABASE_NAME_PREDICATE_RE = /^SUPABASE_[A-Z0-9_]+$/;

/** Override-name validation grammar — entries in
 *  `infer.supabaseNames` must match this to be honored. Non-digit leading
 *  character + uppercase letters/digits/underscores only — the env-var-safe
 *  shape secret names normally take. Rejects whitespace, control chars,
 *  lowercase, dots/dashes, and leading digits. */
export const SUPABASE_OVERRIDE_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface InferConfig {
  supabaseNames?: unknown; // validated dynamically — see sanitizeSupabaseOverride
}

export interface SupabaseDetectorContext {
  cwd: string;
  secretName: string;
  inferConfig: InferConfig | null;
}

export interface SupabaseDetectorResult {
  /** Empty or single-element array. When non-empty, the element is the
   *  `supabase:<scope>` shorthand to be appended to the entry's destinations
   *  list. `<scope>` is the project_ref when one is known, else a sentinel
   *  the user must edit before running `provision`. */
  destinations: string[];
  /** Zero or more needs_edit issues. The wiring maps these to the existing
   *  `{ secret, issue }` InferGateIssue shape before surfacing in InferResult. */
  issues: SupabaseDetectorIssue[];
}

interface SanitizedOverride {
  validNames: Set<string>;
  /** Issue to surface if any invalid entries were dropped. Null when the
   *  override was either absent, fully valid, or itself non-array (the
   *  non-array path emits a distinct whole-override-dropped issue). */
  invalidEntriesIssue: SupabaseDetectorIssue | null;
  /** Issue to surface when the whole `infer.supabaseNames` value is not an
   *  array. Null otherwise. */
  wholeOverrideDroppedIssue: SupabaseDetectorIssue | null;
}

/**
 * Decide which override-name entries are valid + emit a single needs_edit
 * issue naming any rejected entries. Per spec §2 "infer.supabaseNames
 * validation": individual bad entries drop but valid siblings still take
 * effect; only a non-array `supabaseNames` value drops the whole override.
 */
function sanitizeSupabaseOverride(raw: unknown): SanitizedOverride {
  const validNames = new Set<string>();

  if (raw === undefined || raw === null) {
    return { validNames, invalidEntriesIssue: null, wholeOverrideDroppedIssue: null };
  }

  if (!Array.isArray(raw)) {
    return {
      validNames,
      invalidEntriesIssue: null,
      wholeOverrideDroppedIssue: {
        kind: "supabase_inferconfig_invalid",
        message:
          "secret-shuttle.config.json: `infer.supabaseNames` must be an array of strings. " +
          "Whole override ignored; default SUPABASE_* name predicate is in effect.",
      },
    };
  }

  const rejected: Array<{ index: number; descriptor: string }> = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      rejected.push({ index: i, descriptor: `[${i}]: non-string (${typeof entry})` });
      continue;
    }
    if (!SUPABASE_OVERRIDE_NAME_RE.test(entry)) {
      rejected.push({ index: i, descriptor: `[${i}]: ${JSON.stringify(entry)}` });
      continue;
    }
    validNames.add(entry);
  }

  if (rejected.length > 0) {
    return {
      validNames,
      invalidEntriesIssue: {
        kind: "supabase_inferconfig_invalid",
        message:
          "secret-shuttle.config.json: `infer.supabaseNames` rejected " +
          rejected.length +
          " invalid entr" + (rejected.length === 1 ? "y" : "ies") + ": " +
          rejected.map((r) => r.descriptor).join("; ") +
          ". Entry grammar is ^[A-Z_][A-Z0-9_]*$ (uppercase + digits + underscores, " +
          "non-digit first char — no whitespace, control chars, lowercase, dots, " +
          "dashes, or leading digits). Valid entries in the same array still routed.",
      },
      wholeOverrideDroppedIssue: null,
    };
  }

  return { validNames, invalidEntriesIssue: null, wholeOverrideDroppedIssue: null };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Read .supabase/project.json defensively. Returns the ref string when
 *  valid, null otherwise. Treats missing file, malformed JSON, missing
 *  `ref` field, and non-string `ref` all as "not linked." */
async function readProjectRef(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, ".supabase/project.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const ref = (parsed as Record<string, unknown>)["ref"];
    if (typeof ref !== "string" || ref.length === 0) {
      return null;
    }
    return ref;
  } catch {
    return null;
  }
}

export async function detectSupabaseForSecret(
  ctx: SupabaseDetectorContext,
): Promise<SupabaseDetectorResult> {
  // 1. Sanitize the override list (emit issues for any invalid entries).
  const sanitized = sanitizeSupabaseOverride(ctx.inferConfig?.supabaseNames);
  const overrideIssues: SupabaseDetectorIssue[] = [];
  if (sanitized.wholeOverrideDroppedIssue !== null) {
    overrideIssues.push(sanitized.wholeOverrideDroppedIssue);
  }
  if (sanitized.invalidEntriesIssue !== null) {
    overrideIssues.push(sanitized.invalidEntriesIssue);
  }

  // 2. Apply the name predicate. If predicate fails, emit no destination
  //    (but still surface override-validation issues so the user sees them).
  const predicateMatches =
    SUPABASE_NAME_PREDICATE_RE.test(ctx.secretName) ||
    sanitized.validNames.has(ctx.secretName);
  if (!predicateMatches) {
    return { destinations: [], issues: overrideIssues };
  }

  // 3. Predicate matched. Check for Supabase project on disk.
  const hasConfig = await fileExists(join(ctx.cwd, "supabase/config.toml"));
  if (!hasConfig) {
    // No Supabase project — name matched but no signal. Emit nothing.
    return { destinations: [], issues: overrideIssues };
  }

  // 4. Resolve project_ref. When absent/malformed, emit needs_edit + sentinel.
  const ref = await readProjectRef(ctx.cwd);
  if (ref === null) {
    return {
      destinations: ["supabase:TODO_run_supabase_link_first"],
      issues: [
        ...overrideIssues,
        {
          kind: "supabase_not_linked",
          message:
            "Supabase target detected (`supabase/config.toml` present) but project not linked. " +
            "Run `supabase link --project-ref <ref>` first, then re-run `secret-shuttle provision --infer`.",
        },
      ],
    };
  }

  return {
    destinations: [`supabase:${ref}`],
    issues: overrideIssues,
  };
}
```

- [ ] **Step 2.2.2: Confirm the additive issue contract (do NOT touch `infer-gate.ts`)**

Code-Grounding fact #6 establishes the existing `InferGateIssue` shape is `{ secret: string; issue: string }` (confirmed at `src/cli/provision/infer-gate.ts:31-34`), and `isInferYmlExecutable` plus the existing infer tests depend on it. The Supabase detector therefore emits its own `SupabaseDetectorIssue` (`{ kind; message }`) — defined in `infer-supabase.ts` above — NOT `InferGateIssue`. The mapping from `SupabaseDetectorIssue` → `InferGateIssue` happens in the wiring (Task 2.3.2), not here.

`infer-gate.ts` is NOT modified by this burst. There is no closed union of "kinds" to extend (the gate's issues have no `kind` field). If `tsc` complains, the fix is in `infer-supabase.ts` or the Task-2.3 mapping — never in `infer-gate.ts`.

- [ ] **Step 2.2.3: Build to verify TypeScript is clean**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: clean (no output). At this point the detector only references its own `SupabaseDetectorIssue` type — no `infer-gate.ts` import — so the only thing tsc validates here is the detector module's internal consistency (the `SupabaseDetectorIssue` ↔ `InferGateIssue` mapping is added later, in the Task 2.3 wiring).

- [ ] **Step 2.2.4: Run the fixture (a) test, verify it PASSES**

```bash
npm test -- --test-name-pattern "supabase" 2>&1 | tail -10
```
Expected: fixture (a) passes.

- [ ] **Step 2.2.5: Commit the detector (alone, before wiring)**

```bash
git add src/cli/provision/infer-supabase.ts src/cli/provision/infer-supabase.test.ts
git commit -m "feat(infer): detectSupabaseForSecret — per-secret name-predicate-gated detector"
```

(`infer-gate.ts` is intentionally NOT staged — the burst does not modify it; the Supabase detector uses its own additive `SupabaseDetectorIssue` type.)

---

### Task 2.3: Wire `detectSupabaseForSecret` into `runInfer`

**Files:**
- Modify: `src/cli/provision/infer.ts`

- [ ] **Step 2.3.1: Add the optional inferConfig loader**

At the top of `src/cli/provision/infer.ts`, near other helper definitions, add:

```ts
// Burst 6 §2: optional opt-in override for Supabase routing.
import type { InferConfig } from "./infer-supabase.js";

async function loadInferConfig(cwd: string): Promise<InferConfig | null> {
  try {
    const raw = await readFile(join(cwd, "secret-shuttle.config.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const root = parsed as Record<string, unknown>;
    const infer = root["infer"];
    if (infer === undefined || infer === null || typeof infer !== "object" || Array.isArray(infer)) {
      return null;
    }
    // Pass through whatever shape is at `infer` — detectSupabaseForSecret
    // sanitizes inside (and emits needs_edit issues for invalid entries).
    return infer as InferConfig;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2.3.2: Thread the config + Supabase detector into the entries.map loop**

Modify `runInfer` (around lines 32-72 of `infer.ts`). The current shape:
```ts
  const destinations = await detectDestinations(opts.cwd);

  const entries: InferredPlanEntry[] = names.map((name) => {
    const source = inferSourceForName(name);
    return {
      secret: name,
      ref: refFor(name, source),
      source: source as InferredPlanEntry["source"],
      destinations: destinations.length > 0 ? [...destinations] : [],
    };
  });
```

Replace with (NOTE: the inner closure becomes async; switch `map` → an awaited loop):

```ts
  const destinations = await detectDestinations(opts.cwd);
  const inferConfig = await loadInferConfig(opts.cwd);

  const entries: InferredPlanEntry[] = [];
  // Collect detector-native issues ({ kind; message }) first, then map to the
  // gate's { secret; issue } shape after the loop. We track the originating
  // secret per issue so the mapping can fill InferGateIssue.secret.
  const supabaseRaw: Array<{ secret: string; issue: SupabaseDetectorIssue }> = [];

  for (const name of names) {
    const source = inferSourceForName(name);
    // Burst 6 §2: per-secret Supabase routing. The project-wide detectors
    // above contribute their string[] uniformly; Supabase appends per-secret
    // only when the name predicate matches.
    const supa = await detectSupabaseForSecret({
      cwd: opts.cwd,
      secretName: name,
      inferConfig,
    });

    // Dedupe issues: the same override-validation issue would otherwise
    // surface once per secret. Compare by `kind + message` (override issues
    // are batch-wide, not secret-specific, so identical text recurs).
    for (const issue of supa.issues) {
      const dedupeKey = `${issue.kind}::${issue.message}`;
      const seen = supabaseRaw.some(
        (r) => `${r.issue.kind}::${r.issue.message}` === dedupeKey,
      );
      if (!seen) supabaseRaw.push({ secret: name, issue });
    }

    entries.push({
      secret: name,
      ref: refFor(name, source),
      source: source as InferredPlanEntry["source"],
      destinations: [
        ...(destinations.length > 0 ? destinations : []),
        ...supa.destinations,
      ],
    });
  }

  // Map the detector-native SupabaseDetectorIssue[] to the existing
  // InferGateIssue { secret; issue } contract. The detector's machine-readable
  // `kind` is folded into the human-readable `issue` string so no information
  // is lost while still conforming to the unchanged InferGateIssue shape.
  const supabaseIssues: InferGateIssue[] = supabaseRaw.map((r) => ({
    secret: r.secret,
    issue: `[${r.issue.kind}] ${r.issue.message}`,
  }));
```

Then merge `supabaseIssues` into the existing gate-issues array that the function returns. The current shape:
```ts
  const gate = isInferYmlExecutable(entries);
  const yml = renderYml(entries);

  return {
    yml,
    executable: gate.ok,
    issues: gate.issues,
    plan: entries,
  };
```

Becomes:
```ts
  const gate = isInferYmlExecutable(entries);
  const yml = renderYml(entries);

  return {
    yml,
    // If supabase-derived needs_edit issues exist, the yml isn't fully
    // executable until the user resolves them (e.g., runs `supabase link`).
    executable: gate.ok && supabaseIssues.length === 0,
    issues: [...gate.issues, ...supabaseIssues],
    plan: entries,
  };
```

Imports at the top of `infer.ts` need extending:
```ts
import {
  detectSupabaseForSecret,
  type InferConfig,
  type SupabaseDetectorIssue,
} from "./infer-supabase.js";
```
(The `InferGateIssue` import already exists from `./infer-gate.js` — it stays, since the mapped `supabaseIssues` are `InferGateIssue[]`. The `loadInferConfig` helper in Step 2.3.1 also imports `type InferConfig`; consolidate into a single import statement to avoid a duplicate.)

- [ ] **Step 2.3.3: Type-check + run all infer tests**

```bash
npx tsc --noEmit 2>&1 | head -20
npm test -- --test-name-pattern "infer" 2>&1 | tail -15
```
Expected: typecheck clean; all existing `infer.test.ts` tests still pass; supabase fixture (a) still passes.

**Watch for:** if existing infer tests assert against `result.destinations` order or count, the new Supabase appending may surface as a regression. Inspect each failure: if the test fixture happens to have a Supabase config + matching name, that's a new correct destination (update test expectations); otherwise it's a real regression.

- [ ] **Step 2.3.3b: Add the `runInfer` end-to-end integration test (spec §8 criterion 2)**

The fixtures in Task 2.4 exercise `detectSupabaseForSecret` in isolation. Spec §8 criterion 2 is about the *wired* behavior — `provision --infer` on a mixed Vercel + Supabase project routes Supabase to matching names and Vercel to the others. Add ONE integration test to `src/cli/provision/infer.test.ts` (the existing `runInfer` test file) that proves the full pipeline end-to-end. Use the same `mkdtemp` + `writeFile` pattern as the existing tests:

```ts
test("runInfer: mixed Vercel + Supabase project routes Supabase to matching names, Vercel to all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-infer-mixed-"));
  try {
    // Mixed signals: vercel.json (project-wide Vercel) + a linked Supabase project.
    await writeFile(join(dir, "vercel.json"), "{}\n");
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );
    // .env.example mixes a Supabase-predicate name with a non-matching one,
    // plus a config-override name to prove the escape hatch end-to-end.
    // NOTE: the override name must still infer a *known* source, or the gate
    // marks the plan non-executable (`unknown` source → needs_edit issue).
    // `DATABASE_SERVICE_SECRET` ends in `_SECRET` with no provider prefix, so
    // the generic random rule (`infer-rules.ts`) gives it `random_32_bytes` —
    // a known source — keeping `issues === []` / `executable === true` true.
    await writeFile(
      join(dir, ".env.example"),
      "SUPABASE_SERVICE_ROLE_KEY=\nSTRIPE_WEBHOOK_SECRET=\nDATABASE_SERVICE_SECRET=\n",
    );
    await writeFile(
      join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ infer: { supabaseNames: ["DATABASE_SERVICE_SECRET"] } }),
    );

    const result = await runInfer({ cwd: dir });

    const bySecret = new Map(result.plan.map((e) => [e.secret, e.destinations]));
    // Supabase name → both Vercel (project-wide) AND Supabase (per-secret, ref-stamped).
    assert.deepEqual(bySecret.get("SUPABASE_SERVICE_ROLE_KEY"), [
      "vercel:production",
      "supabase:abcdefghijklmnopqrst",
    ]);
    // Non-matching name → Vercel only (predicate gates Supabase out).
    assert.deepEqual(bySecret.get("STRIPE_WEBHOOK_SECRET"), ["vercel:production"]);
    // Override name → Vercel + Supabase (escape hatch works through the wiring).
    assert.deepEqual(bySecret.get("DATABASE_SERVICE_SECRET"), [
      "vercel:production",
      "supabase:abcdefghijklmnopqrst",
    ]);
    // No needs_edit issues (project is linked, override is valid).
    assert.deepEqual(result.issues, []);
    assert.equal(result.executable, true);
    // The rendered yml carries the Supabase destination too.
    assert.match(result.yml, /supabase:abcdefghijklmnopqrst/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Make sure `infer.test.ts` imports `mkdir` and `rm` from `node:fs/promises` (the existing test file may only import `writeFile` + `mkdtemp`) and `runInfer` from `./infer.js`. Run it:
```bash
npm test -- --test-name-pattern "mixed Vercel \+ Supabase" 2>&1 | tail -10
```
Expected: PASS. If `result.destinations` ordering differs (Supabase appended before/after the project-wide list), reconcile against the wiring in Step 2.3.2 — the wiring spreads project-wide `destinations` first, then `supa.destinations`, so Vercel precedes Supabase as asserted above.

- [ ] **Step 2.3.4: Commit the wiring + integration test**

```bash
git add src/cli/provision/infer.ts src/cli/provision/infer.test.ts
git commit -m "feat(infer): runInfer threads inferConfig + invokes detectSupabaseForSecret per-secret"
```

---

### Task 2.4: Comprehensive fixture tests (spec §2.4 fixtures b–g.3)

**Files:**
- Modify: `src/cli/provision/infer-supabase.test.ts`

- [ ] **Step 2.4.1: Add fixture (b): config.toml present, project.json absent + matching name**

Append to `src/cli/provision/infer-supabase.test.ts`:
```ts
test("(b) supabase config present, NOT linked + SUPABASE_ name → TODO sentinel + needs_edit", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    // Deliberately NO .supabase/project.json

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_ANON_KEY",
      inferConfig: null,
    });

    assert.deepEqual(result.destinations, ["supabase:TODO_run_supabase_link_first"]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_not_linked");
    assert.match(result.issues[0]?.message ?? "", /supabase link --project-ref/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.2: Add fixture (c): malformed project.json + matching name**

```ts
test("(c) supabase config present, project.json is malformed JSON + matching name → same as (b)", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(join(dir, ".supabase/project.json"), "{ this is not valid json");

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_SERVICE_ROLE_KEY",
      inferConfig: null,
    });

    assert.deepEqual(result.destinations, ["supabase:TODO_run_supabase_link_first"]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_not_linked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.3: Add fixture (d): no supabase config at all**

```ts
test("(d) no supabase/config.toml → no Supabase destination regardless of name", async () => {
  const dir = await setupTmp();
  try {
    // No supabase/ directory.
    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "SUPABASE_SERVICE_ROLE_KEY",
      inferConfig: null,
    });
    assert.deepEqual(result.destinations, []);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.4: Add fixture (e): linked + non-matching name → no Supabase**

```ts
test("(e) linked + non-matching name (STRIPE_*) → no Supabase destination (predicate gates routing)", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "STRIPE_WEBHOOK_SECRET",
      inferConfig: null,
    });

    assert.deepEqual(result.destinations, []);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.5: Add fixture (f): non-matching name in override → emits Supabase**

```ts
test("(f) linked + non-matching name listed in infer.supabaseNames → emits Supabase destination", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "DATABASE_SERVICE_KEY", // doesn't match SUPABASE_*
      inferConfig: { supabaseNames: ["DATABASE_SERVICE_KEY"] },
    });

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.6: Add fixture (g.1): mixed valid + invalid grammar override entries**

```ts
test("(g.1) supabaseNames array mixes valid + grammar-invalid entries → invalid dropped per-entry, valid routes", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    // The valid entry MY_VALID_NAME should still route this secret to
    // Supabase. The invalid sibling entries surface a single needs_edit.
    const inferConfig = {
      supabaseNames: [
        "MY_VALID_NAME",       // valid (passes ^[A-Z_][A-Z0-9_]*$)
        "has whitespace",       // invalid (spaces)
        "lowercase",            // invalid (lowercase)
        "1BAD_SECRET",          // invalid (leading digit)
        "dot.in.name",          // invalid (dots)
        "dash-in-name",         // invalid (dashes)
      ],
    };

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "MY_VALID_NAME",
      inferConfig,
    });

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.equal(result.issues.length, 1, "exactly one consolidated issue listing rejected entries");
    assert.equal(result.issues[0]?.kind, "supabase_inferconfig_invalid");
    const msg = result.issues[0]?.message ?? "";
    assert.match(msg, /rejected 5 invalid entr/, "message names the count");
    assert.match(msg, /has whitespace/, "message names the whitespace entry");
    assert.match(msg, /1BAD_SECRET/, "message names the leading-digit entry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.7: Add fixture (g.2): mixed valid + non-string entries**

```ts
test("(g.2) supabaseNames array mixes valid + non-string entries → non-string dropped, valid routes", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const inferConfig = {
      supabaseNames: [
        "MY_VALID_NAME",
        123,
        null,
        { weird: "object" },
      ],
    };

    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "MY_VALID_NAME",
      inferConfig: inferConfig as never, // bypass TS — we're testing the runtime guard
    });

    assert.deepEqual(result.destinations, ["supabase:abcdefghijklmnopqrst"]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_inferconfig_invalid");
    const msg = result.issues[0]?.message ?? "";
    assert.match(msg, /rejected 3 invalid entr/, "non-string entries counted");
    assert.match(msg, /non-string \(number\)/, "type of 123 named");
    assert.match(msg, /non-string \(object\)/, "type of null + object named (typeof null === 'object')");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.8: Add fixture (g.3): whole override is not an array**

```ts
test("(g.3) supabaseNames value is not an array → whole override dropped, single needs_edit emitted", async () => {
  const dir = await setupTmp();
  try {
    await mkdir(join(dir, "supabase"));
    await writeFile(join(dir, "supabase/config.toml"), 'project_id = "local-dev"\n');
    await mkdir(join(dir, ".supabase"));
    await writeFile(
      join(dir, ".supabase/project.json"),
      JSON.stringify({ ref: "abcdefghijklmnopqrst" }),
    );

    const inferConfig = { supabaseNames: "FOO" as never };

    // Default predicate still matches SUPABASE_ names; override is
    // dropped so DATABASE_KEY (which doesn't match the default) gets no
    // Supabase routing.
    const result = await detectSupabaseForSecret({
      cwd: dir,
      secretName: "DATABASE_KEY",
      inferConfig: inferConfig as never,
    });

    assert.deepEqual(result.destinations, [], "override was dropped, default predicate doesn't match");
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.kind, "supabase_inferconfig_invalid");
    const msg = result.issues[0]?.message ?? "";
    assert.match(msg, /must be an array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2.4.9: Run all infer-supabase tests, verify PASS**

```bash
npm test -- --test-name-pattern "infer-supabase|supabase" 2>&1 | tail -20
```
Expected: 9 tests PASS, 0 FAIL.

- [ ] **Step 2.4.10: Run the full suite to confirm no regressions**

```bash
npm test 2>&1 | tail -10
```
Expected: prior baseline + 9 new = 1577 pass (or close — adjust to whatever the actual count was after the prior tasks).

- [ ] **Step 2.4.11: Commit**

```bash
git add src/cli/provision/infer-supabase.test.ts
git commit -m "$(cat <<'EOF'
test(infer-supabase): comprehensive fixtures for per-secret routing + override validation

Burst 6 §2.4. Nine fixtures cover:
- (a) linked + matching name → emits ref-stamped destination
- (b) unlinked + matching name → TODO sentinel + needs_edit
- (c) malformed project.json + matching name → same as (b)
- (d) no supabase/config.toml → no destination
- (e) linked + non-matching name → no destination (predicate gates)
- (f) non-matching name in supabaseNames override → emits destination
- (g.1) grammar-invalid override entries → per-entry drop, valid sibling routes
- (g.2) non-string override entries → per-entry drop, valid sibling routes
- (g.3) whole supabaseNames not an array → whole override dropped + issue

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## §4 — Demo Scene 0

### Task 4.1: Read the existing demo structure + write Scene 0 markup

**Files:**
- Modify: `demo/index.html`

- [ ] **Step 4.1.1: Read the existing demo file structure**

```bash
wc -l demo/index.html
grep -n 'data-scene=' demo/index.html | head -20
grep -n 'scene-meta' demo/index.html | head -10
grep -n 'function.*[Ss]cene' demo/index.html | head -10
```

Take notes on:
- The exact `data-scene="N"` attribute pattern
- Where the scene-meta divs live (likely a `<nav>` or similar at the top)
- The JS function that advances scenes on click
- Whether any function reads `location.search` or `URLSearchParams`

- [ ] **Step 4.1.2: Determine the existing scene numbering**

The spec says scenes 1-9 exist. Confirm:
```bash
grep -oE 'data-scene="[0-9]+"' demo/index.html | sort -u
```
Expected: `data-scene="1"` through `data-scene="9"` (or 0-8, or whatever the actual range is).

If the existing range is 0-8 (instead of 1-9), the spec's "prepend Scene 0" guidance needs adapting — we'd prepend as a new lowest number that doesn't yet exist. Document any discrepancy.

- [ ] **Step 4.1.3: Insert Scene 0 markup**

The Scene 0 content is three beats (per spec §4): terminal-left provisioning, hub approval card right, terminal-left audit success. Compose the HTML following the exact pattern other scenes use. Concretely:

Add a new `.scene-stage[data-scene="0"]` block (or whatever the prevailing scene-container element is) at the front of the scene-list HTML. Add a matching `.scene-meta` entry. Add a section divider in the scene-meta list (between Scene 0's entry and Scene 1's entry) labeled "Advanced: low-level mechanics."

Approximate structure (adapt to actual existing pattern):
```html
<div class="scene-stage" data-scene="0">
  <div class="term">
    <pre class="term-prompt">$ secret-shuttle provision --infer</pre>
    <pre class="term-output">→ Generated secret-shuttle.yml from .env.example + framework signals.
→ vercel:production (vercel.json detected)
→ supabase:abcdefghijklmnopqrst (supabase/config.toml + .supabase/project.json detected)

$ secret-shuttle provision
{
  "error_code": "approval_required",
  "message": "1 batch approval required.",
  "details": {
    "batch_id": "b_8f3...",
    "approvals": [
      { "approval_id": "ag_2a...", "expires_at": "..." }
    ]
  }
}</pre>
  </div>
  <div class="approval-card">
    <div class="approval-header">Approve provisioning</div>
    <div class="approval-body">
      <p>3 secrets → vercel:production, supabase:&lt;ref&gt;</p>
      <label>
        <input type="checkbox" checked />
        Also approve any matching shape for the next
        <select><option>15 min</option></select>
      </label>
    </div>
    <button class="approve-btn">Approve</button>
  </div>
  <div class="term term-right">
    <pre class="term-prompt">$ secret-shuttle provision --continue --batch b_8f3... --approval-id ag_2a...</pre>
    <pre class="term-output">{ "ok": true, "batch_status": "completed", "completed": 3, "refs": [...] }

$ secret-shuttle audit --since 1m --json
{ "ok": true, "summary": { "batches": [ { "id": "b_8f3...", "steps": [ ... ] } ] } }</pre>
  </div>
</div>
```

**Critical:** existing scenes 1-9 MUST remain at their existing `data-scene` numbers. Scene 0 is PREPENDED — do not renumber.

- [ ] **Step 4.1.4: Add the scene-meta caption for Scene 0**

In the scene-meta navigation (the captions/dots area), prepend an entry for Scene 0 with caption text like "0. Magic path — provision → approve → audit". After the Scene 0 caption, add a section divider (a `<li class="scene-meta-divider">Advanced: low-level mechanics</li>` or whatever the existing structure permits) before the Scene 1 caption.

- [ ] **Step 4.1.5: Add CSS for the new layout**

Find the existing `.scene-stage[data-scene="N"]` CSS blocks. Add a `.scene-stage[data-scene="0"]` block defining the three-pane layout (terminal-left ~40%, approval-card-center ~30%, terminal-right ~30%). Match the type/spacing of existing scenes.

- [ ] **Step 4.1.6: Open the demo locally to verify visual integrity**

```bash
# From the repo root:
open demo/index.html
```
Click through scenes 0 → 1 → ... → 9 manually. Verify:
- Scene 0 displays the three-beat magic path.
- The section divider labels scenes 1-9 as "Advanced: low-level mechanics".
- Scenes 1-9 themselves are unchanged.
- Forward/back navigation still works.

If any visual regression in scenes 1-9, fix before proceeding — preserving the existing scenes is part of §4's mandatory non-renumber policy.

- [ ] **Step 4.1.7: Commit Scene 0 markup (without query-param yet)**

```bash
git add demo/index.html
git commit -m "feat(demo): add Scene 0 (provision-magic path) — preserves scenes 1-9 as 'Advanced: low-level mechanics'"
```

---

### Task 4.2: Add `?scene=N` query-param parsing + update README link

**Files:**
- Modify: `demo/index.html`
- Modify: `README.md`

- [ ] **Step 4.2.1: Find the scene-init function**

```bash
grep -n 'function.*[Ss]cene\|setScene\|currentScene\|location' demo/index.html | head -10
```
Locate the JS that decides which scene shows on page load (likely defaults to scene 1 or first-found).

- [ ] **Step 4.2.2: Add query-param parsing**

If `URLSearchParams` is not already used, add it near the scene-init function:
```js
// Default to Scene 0 (the magic path) on a bare load — this is the
// spec §8 success criterion: a direct demo visitor must see the magic
// path as the opening scene (within 15s). `?scene=1..9` preserves deep
// links into the "Advanced: low-level mechanics" scenes; an out-of-range
// or non-numeric value also falls back to Scene 0.
function getInitialScene() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('scene');
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 9) return 0;
  return n;
}
```

Replace the existing initial-scene constant/call with `getInitialScene()`. **Behavior change (intentional, per spec §8 criterion 4 + the finding):** a bare `demo/index.html` load now opens on Scene 0, NOT the old default. Direct visitors (who never get the `?scene=0` README link) must still land on the magic path. Deep links `?scene=1..9` continue to resolve to their exact scene, so no in-flight link breaks.

- [ ] **Step 4.2.3: Test the parsing**

Open in browser:
- `file:///.../demo/index.html` → Scene 0 (the new magic-path is now the default)
- `file:///.../demo/index.html?scene=0` → Scene 0 (the new magic-path)
- `file:///.../demo/index.html?scene=5` → existing Scene 5
- `file:///.../demo/index.html?scene=99` → fallback to Scene 0
- `file:///.../demo/index.html?scene=abc` → fallback to Scene 0

- [ ] **Step 4.2.4: Update README hero embed**

In `README.md`, find:
```markdown
[**▶ Walk through the demo →**](https://pdumicz.github.io/secret-shuttle/demo/)
```
Replace with:
```markdown
[**▶ Walk through the demo →**](https://pdumicz.github.io/secret-shuttle/demo/?scene=0)
```

- [ ] **Step 4.2.5: Run drift-guard tests to confirm no regression**

```bash
npm test -- --test-name-pattern "drift-guard" 2>&1 | tail -10
```
Expected: still passes (the new demo URL doesn't add any removed-verb tokens to README).

- [ ] **Step 4.2.6: Commit**

```bash
git add demo/index.html README.md
git commit -m "feat(demo): ?scene=N query-param support + README hero points at Scene 0"
```

---

## §5 — Dogfood template file

### Task 5.1: Ship `docs/dogfood/burst6-template.md`

**Files:**
- Create: `docs/dogfood/burst6-template.md`

- [ ] **Step 5.1.1: Check the directory exists**

```bash
ls -la docs/dogfood/ 2>&1 || echo "directory absent"
```
If absent: `mkdir -p docs/dogfood`.

- [ ] **Step 5.1.2: Write the template**

Create `docs/dogfood/burst6-template.md`:
```markdown
# Burst 6 Dogfood Friction Log

**Date filled:** YYYY-MM-DD
**Filled by:** Patryk
**Test project:** [fresh Next.js + Stripe + Supabase, e.g., `/tmp/ss-dogfood-burst6/`]
**Agent runtime:** [Claude Code / Cursor / Codex / etc.]
**secret-shuttle version under test:** 0.3.1
**Reference spec:** [docs/superpowers/specs/2026-05-29-burst6-vision-polish-design.md §5](../superpowers/specs/2026-05-29-burst6-vision-polish-design.md)

---

## Quick-reference card

**Setup recipe (one-time):**
```bash
mkdir /tmp/ss-dogfood-burst6 && cd /tmp/ss-dogfood-burst6
npx create-next-app@latest . --yes
npm install stripe @supabase/supabase-js
npx supabase init
npx supabase link --project-ref <a real Supabase test project ref>
cat > .env.example <<EOF
STRIPE_WEBHOOK_SECRET=
SUPABASE_SERVICE_ROLE_KEY=
INTERNAL_CRON_SECRET=
EOF
```

**Agent prompt (paste into a fresh Claude/Cursor session):**

> Set up secret-shuttle in this project. I need a Stripe webhook secret pushed to Vercel production, a Supabase service-role key pushed to Supabase production, and an internal cron secret generated and pushed to Vercel production. The Stripe one I need to capture from the Stripe dashboard.

**What to time:**
- "First agent message" timestamp
- "audit --since 5m" success timestamp
- Difference = wall-clock for the publish gate

---

## Release-blocker gate

(Per spec §5: ALL must hold for `npm publish 0.3.1` to be unblocked.)

- [ ] Agent reached `secret-shuttle audit --since 5m` showing both Stripe + Supabase secrets pushed end-to-end
- [ ] Exactly one human approval click happened (one hub card, one click — not multiple)
- [ ] No secret value (raw bytes) appeared in any log, audit row, or agent-visible surface
- [ ] Audit log shows correct `agent_id`, `batch_id`, all required fields populated
- [ ] Agent did not need to read source code, internal docs, or contact a human spelunker to recover from a failure

**Verdict:** ☐ Pass / ☐ Block (if any unchecked, publish is blocked until fixed and re-run.)

---

## UX target metrics (informational, not release-blocking)

(Per spec §5: misses are logged to v0.3.2 backlog but don't block publish.)

- [ ] Zero clarifying questions from the agent beyond the initial prompt
- [ ] Total wall-clock under 5 minutes (excluding human approval-click decision time)
- [ ] No polish gaps surfaced in wording / demo / README phrasing

**Wall-clock measured:** __ min __ sec

---

## Section 1 — Worked well (magic moments)

[Notes on what flew. Be specific — name verbs, prompts, scene URLs, error codes.]

- 
- 

---

## Section 2 — Friction (where the agent paused, asked, or recovered)

[Notes. Each entry should name the verb/step, what blocked, and how recovery happened (or didn't).]

- 
- 

---

## Section 3 — Bugs (anything that errored or behaved unexpectedly)

[Concrete reproducible-or-not-reproducible bugs. If reproducible, paste the agent's transcript + the daemon's audit/error response.]

- 
- 

---

## Section 4 — Polish backlog (v0.3.2 / v0.4.0 candidates)

[UX target misses that don't block publish. File as ranked items.]

- 
- 

---

## Verdict + next steps

**Publish 0.3.1?** ☐ Yes / ☐ No (if no, list the blocker tasks needed before re-run)

**v0.3.2 backlog seeded?** ☐ Yes / ☐ No
```

- [ ] **Step 5.1.3: Verify the file**

```bash
wc -l docs/dogfood/burst6-template.md
head -10 docs/dogfood/burst6-template.md
```

- [ ] **Step 5.1.4: Commit**

```bash
git add docs/dogfood/burst6-template.md
git commit -m "$(cat <<'EOF'
docs(dogfood): ship Burst 6 friction-log template for the post-burst release gate

Burst 6 §5. The template ships as part of this burst; the dogfood RUN
is a separate post-burst human release gate (per spec §5 pass criteria)
that blocks \`npm publish 0.3.1\` but does NOT gate Burst 6 merge.

Template carries:
- Quick-reference setup recipe (create-next-app + supabase init + .env.example)
- Canonical first-prompt-to-agent script
- Release-blocker gate checklist (ALL must hold for publish unblock)
- UX target metrics (informational, not blocking)
- Four note-buckets: worked well, friction, bugs, polish backlog
- Final verdict + next-steps section

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Wrap — CHANGELOG, version bump, codex impl gate

### Task W.1: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step W.1.1: Locate the insertion point**

```bash
grep -n "^## Unreleased\|^### Added (Burst" CHANGELOG.md | head -5
```
Expected: `## Unreleased` near the top, with `### Added (Burst 5 — Magic Polish)` as the first subsection. The Burst 6 subsection inserts as a sibling SUBSECTION above Burst 5 (both under `## Unreleased`).

- [ ] **Step W.1.2: Insert the Burst 6 subsection**

Above the existing `### Added (Burst 5 — Magic Polish)` line, insert:

```markdown
### Added (Burst 6 — Vision Polish)

- **`provision --infer` Supabase detector (§2):** per-secret name-predicate-gated detector. Default predicate is `^SUPABASE_[A-Z0-9_]+$`. Optional `infer.supabaseNames` override in `secret-shuttle.config.json` extends the predicate (per-entry grammar `^[A-Z_][A-Z0-9_]*$`; invalid entries drop individually with a `needs_edit` issue naming the offending value; whole `supabaseNames` non-array drops the whole override with one `needs_edit`). When the predicate matches and `supabase/config.toml` is present, the detector reads `.supabase/project.json`'s `ref` field for the cloud project_ref. Missing / malformed `project.json` → emits `supabase:TODO_run_supabase_link_first` + a `needs_edit` instructing the user to run `supabase link --project-ref <ref>` first.
- **README positioning section (§3):** new "Why not Doppler / Infisical / 1Password CLI / Vercel envs?" section between the hero and Quickstart. 4-row comparison table answers "what's different about this?" in 30 seconds.
- **Demo Scene 0 (§4):** new opening scene shows the `provision --infer → approve → audit` magic path. Existing scenes 1-9 preserved verbatim under a new "Advanced: low-level mechanics" divider (deep links to `?scene=N` keep working). Demo gains `?scene=N` query-param navigation. README hero link updates to `?scene=0`.
- **Burst-6 friction-log template (§5):** `docs/dogfood/burst6-template.md` pre-populated with setup recipe + release-blocker gate + UX target metrics + four-bucket note structure. The actual dogfood RUN is a post-burst human release gate that blocks `npm publish 0.3.1`, not Burst 6 merge.

### Changed (Burst 6 — Vision Polish)

- **Documentation drift fixes (§1):** top-level `SKILL.md` deleted (canonical skill lives only at `skills/secret-shuttle/SKILL.md`); `package.json` `files` whitelist updated accordingly. Three `agents/*.example.md` files (`AGENTS.md.example`, `codex-instructions.example.md`, `cursor-rules.example.md`) refreshed to use the Burst 5 verb surface (`provision`, `secrets *`, `audit`, `init`). `examples/stripe-to-vercel/walkthrough.md` now leads with the "Magic path" section; existing low-level content (`blind start` / `capture` / `inject` / `template run`) preserved under an "Advanced: low-level mechanics" header as escape-hatch documentation. README banner rewritten from "0.1.1 — early prototype" to honest "0.3.1 — beta" framing.
- **`runInfer` return shape extension:** `result.issues` now includes Supabase-derived `needs_edit` messages (when applicable); `result.executable` reflects them. The existing `InferGateIssue` shape (`{ secret; issue }`) is unchanged — the Supabase detector's internal `{ kind; message }` issues are mapped into `{ secret, issue }` (the `kind` folded into the `issue` string as a `[kind]` prefix) before merging, so consumers reading `result.issues` see the extended list in the same shape they already parse.

### Added — Burst 6 drift-guard tests

`src/e2e/skill-md-toplevel-absent.test.ts` (prevents accidental re-introduction of the top-level SKILL.md); `src/e2e/docs-no-removed-verbs.test.ts` (prevents the agent-facing docs from regressing to reference removed `bootstrap` / `generate` verbs or the legacy `daemon start && unlock` ritual — scanned everywhere with no section exemption; the canonical escape-hatch verbs `blind start` / `capture` / `inject` / `template run` are simply not in the removed-token list, so the walkthrough's "Advanced: low-level mechanics" section passes by construction).

### Known limitations — Burst 6

- The dogfood pass (per spec §5) is a post-burst human release gate; until it runs successfully, the `npm publish 0.3.1` step is blocked. Burst 6 itself merges as soon as the codex impl-stage gate is clean.
- `--infer` detectors for Render / Netlify / Railway / Fly / Firebase still deferred — each requires building a corresponding template first. Tracked in spec §7.E.
- Plan 5a (native keychain adapter), Plan 5s (per-project agent IDs), Plan 5q (Buffer refactor for plaintext-in-memory hygiene), and the CI/CD story are all forward-referenced in spec §7 but not implemented in this burst.

```

- [ ] **Step W.1.3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(CHANGELOG): Burst 6 — Vision Polish (Supabase --infer detector, README positioning, demo Scene 0, dogfood template, doc drift fixes)"
```

---

### Task W.2: Version bump 0.3.0 → 0.3.1 (+ README banner version string, in lockstep)

**Files:**
- Modify: `package.json`
- Modify: `README.md` (inject the `0.3.1` version into the banner left version-neutral by Task 1.6)

- [ ] **Step W.2.1: Bump the version**

In `package.json`, change:
```json
"version": "0.3.0",
```
to:
```json
"version": "0.3.1",
```

- [ ] **Step W.2.1b: Inject the version into the README banner (SAME commit)**

Task 1.6 left the banner version-neutral (`> **Status: beta.** ...`). Now that `package.json` reads `0.3.1`, add the matching version string so README and package version flip together (spec §1.6). Use Edit to change:
```markdown
> **Status: beta.**
```
to:
```markdown
> **Status: 0.3.1 — beta.**
```
(Only the leading `Status:` token changes; the rest of the banner sentence is untouched.)

Verify:
```bash
grep -n "Status:" README.md
grep -n '"version": "0.3.1"' package.json
```
Expected: README banner now reads `Status: 0.3.1 — beta.` AND `package.json` reads `0.3.1` — both in this one commit, so no intermediate state advertises a version `npm view` can't resolve.

- [ ] **Step W.2.2: Verify check-pack still passes**

```bash
npm run check-pack 2>&1 | tail -5
```
Expected: `check-pack: OK (180 files, ...)` — note the file count is one less than v0.3.0 because top-level SKILL.md no longer ships.

- [ ] **Step W.2.3: Verify the full suite still passes**

```bash
npm test 2>&1 | tail -10
```
Expected: 1577+ pass / 0 fail / 18 skip.

- [ ] **Step W.2.4: Commit**

```bash
git add package.json README.md
git commit -m "chore: bump to 0.3.1 + sync README banner version string (Burst 6 — Vision Polish)"
```

(README is staged here so the banner's `0.3.1` version string lands in the SAME commit as the `package.json` bump — spec §1.6.)

---

### Task W.3: Codex impl-stage review gate

- [ ] **Step W.3.1: Confirm we are on the burst6 branch**

```bash
git branch --show-current
git log --oneline main..HEAD | wc -l
```
Expected: branch is `burst6/vision-polish`; commit count is 12-15 (one per task plus the combined README commit).

- [ ] **Step W.3.2: Invoke the codex-review-gate skill**

Use the Skill tool:
```
Skill: codex-review-gate
Args: --stage impl
      --artifact_paths "docs/superpowers/specs/2026-05-29-burst6-vision-polish-design.md,docs/superpowers/plans/2026-05-29-burst6-vision-polish.md"
      --base_ref main
      --summary "<one-paragraph summary of the burst's deliverables>"
```

The summary should name: the §1 doc fixes + drift-guard tests, the §2 per-secret Supabase detector with name predicate + override validation, the §3 README positioning section + 0.3.1 banner, the §4 demo Scene 0 + ?scene= query param, the §5 dogfood friction-log template, and the 0.3.1 version bump.

- [ ] **Step W.3.3: Resolve findings until clean**

Follow the standard codex-review-gate loop:
- Subagent reads `$OUT`, applies fixes, writes status file.
- Loop until `STATUS: CLEAN` (typical 1-3 rounds).
- Each round-commits are individual `fix(burst6-vision-polish): ...` commits.

When the gate reports `STATUS: CLEAN`, Burst 6 is ready to merge.

---

### Task W.4: Merge to main + push (post-gate, ONLY after codex gate is clean)

- [ ] **Step W.4.1: Switch to main, ensure up to date**

```bash
cd /Users/patrykdumicz/Desktop/Codebases/secret-shuttle
git checkout main
git pull
```

- [ ] **Step W.4.2: Merge with `--no-ff`**

```bash
git merge --no-ff burst6/vision-polish -m "$(cat <<'EOF'
Merge branch 'burst6/vision-polish' — Burst 6 Vision Polish

Implements Burst 6 §1-§5 + wrap (Tasks 1.1-1.7, 2.1-2.4, 3.1, 4.1-4.2, 5.1,
W.1-W.2):
- Documentation drift fixes (stale SKILL.md deletion + drift-guards;
  refreshed agents/*.example.md; walkthrough magic-path lead;
  README banner rewrite + positioning section)
- --infer Supabase detector (per-secret name-predicate-gated;
  config.toml signal + project.json project_ref resolution;
  9 fixture tests)
- Demo Scene 0 (magic-path prepended; preserves scenes 1-9;
  ?scene= query param)
- Dogfood friction-log template (release-blocker gate + UX metrics)
- 0.3.1 version bump

Codex-reviewed clean at impl stage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step W.4.3: Re-run tests on the merged tree to verify**

```bash
npm run clean
npm test 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step W.4.4: Push main**

```bash
git push origin main
```

- [ ] **Step W.4.5: Clean up the worktree + delete the branch**

```bash
git worktree remove .worktrees/burst6-vision-polish
git branch -d burst6/vision-polish
git worktree list
git branch
```
Expected: only `main` remains; no worktrees other than the main one.

- [ ] **Step W.4.6: NOTE — npm publish is the user's release gate**

`npm publish` and `git tag v0.3.1` + `git push --tags` are NOT part of Burst 6. They happen AFTER the user runs the dogfood pass (using `docs/dogfood/burst6-template.md`) and the release-blocker gate passes. If the dogfood reveals a blocker, fix as a Burst-6-follow-up commit on main, re-run dogfood, re-evaluate publish.

---

## Self-Review

**Spec coverage:**
- §1.1 Top-level SKILL.md deletion + drift-guard → Task 1.1 ✓
- §1.2 AGENTS.md.example refresh → Task 1.2 ✓
- §1.3 codex-instructions.example.md refresh → Task 1.3 ✓
- §1.4 cursor-rules.example.md refresh → Task 1.4 ✓
- §1.5 walkthrough.md magic-path rewrite → Task 1.5 ✓
- §1.6 README banner rewrite → Task 1.6 (lands with 3.1) ✓
- §1.7 docs-no-removed-verbs drift-guard test → Task 1.7 ✓
- §2 Supabase detector (routing model, validation, fixtures) → Tasks 2.1-2.4 ✓
- §3 README positioning section → Task 3.1 ✓
- §4 Demo Scene 0 + ?scene= query param → Tasks 4.1-4.2 ✓
- §5 Dogfood friction-log template → Task 5.1 ✓
- Wrap (CHANGELOG, version bump, codex gate) → Tasks W.1-W.4 ✓

All seven spec success criteria (spec §8) have a task that lands them.

**Placeholder scan:** No "TBD" / "TODO" placeholders in steps. The TODO sentinel in Task 2.1 fixture is the literal string the detector emits (`"TODO_run_supabase_link_first"`), not a plan placeholder.

**Type consistency:** `detectSupabaseForSecret`, `SupabaseDetectorContext`, `SupabaseDetectorResult`, `SupabaseDetectorIssue`, `InferConfig`, `SUPABASE_NAME_PREDICATE_RE`, `SUPABASE_OVERRIDE_NAME_RE`, `sanitizeSupabaseOverride`, `readProjectRef`, `loadInferConfig` — names match across Tasks 2.1-2.4 and the wiring task 2.3. `SupabaseDetectorIssue.kind` values (`supabase_not_linked`, `supabase_inferconfig_invalid`) consistent across detector + fixture tests. The existing `InferGateIssue` (`{ secret; issue }`) is unchanged; the wiring (Task 2.3.2) maps `SupabaseDetectorIssue` → `InferGateIssue` before merging into `InferResult.issues`.

**Execution risks (carry forward to the executor):**
- The Supabase detector uses its own additive `SupabaseDetectorIssue` (`{ kind; message }`) and the Task 2.3 wiring maps it to the existing `InferGateIssue` (`{ secret; issue }`). `infer-gate.ts` is NOT modified — there is no union of "kinds" to extend (Code-Grounding fact #6; §2 Open-Question resolution). The executor should still read `infer-gate.ts` once to confirm the `{ secret; issue }` shape before writing the Task 2.3.2 mapping.
- The walkthrough.md edit in Task 1.5 requires reading the current file to locate the exact insertion point; the plan describes the structure but the existing prose is unknown until read.
- The demo HTML edit in Tasks 4.1-4.2 is the largest scope-of-unknown — the executor must spend ~15 min reading demo/index.html before editing.
