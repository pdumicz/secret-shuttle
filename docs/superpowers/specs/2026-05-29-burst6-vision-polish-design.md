# Burst 6 — Vision Polish

**Version target:** 0.3.1 (additive — patch release).
**Spec date:** 2026-05-29.
**Sits on top of:** v0.3.0 (Burst 5 "Magic Polish") — already merged to main, not yet `npm publish`-ed.

---

## §0 — Cross-section context

### What this burst is for

Burst 5 shipped the *product* changes — `provision` verb, session affordance, audit verb, layered SKILL.md. The vision-assessment that followed (post-merge, pre-publish) revealed that the **discovery surface** isn't yet ready to carry that product into the world:

- Two SKILL.md files live in the repo; the top-level one still references the removed `bootstrap` verb.
- Three `agents/*.example.md` files reference removed verbs (`generate`, `daemon start && unlock` ritual).
- The `examples/stripe-to-vercel/walkthrough.md` only shows the low-level `blind start`/`capture`/`inject` rituals — never the magic `provision` flow.
- The README hero says **"Status: 0.1.1 — early prototype. Do not trust this with real production secrets yet."** — actively undersells a 0.3.0 that has survived 5 bursts of adversarial review.
- The README has no positioning ("why not Doppler / Infisical / 1Password / Vercel envs?") — a vibe coder skimming the page has no answer to "what does this give me that I don't already have?"
- The demo's 9 scenes show the *low-level* capture flow exclusively. No scene communicates the `provision --infer` magic-path moment.
- `--infer` doesn't yet detect Supabase, despite Supabase being one of the top stacks a Next.js vibe coder ships to AND despite Secret Shuttle already shipping the `supabase-edge-secret-set` template.

This burst closes those gaps. **It is what unblocks W.3 — npm publish 0.3.x.** Until this lands, the "agent finds the repo → it works" loop from the vision doesn't actually function (the `npx secret-shuttle@latest` resolves to 0.1.1, README warns "early prototype," walkthrough teaches deleted verbs).

### What changes vs. what does not

**Unchanged (hard constraints):**
- `provision` verb shape, modes, flags — every Burst 5 §1 wire surface.
- Vault architecture, daemon trust boundary, blind discipline.
- Approval semantics (single-batch approval, session affordance, three-phase mint).
- Audit log format and error-code registry.
- All Burst 4 security primitives (owner-enforced consumption, ALS attribution, per-agent token derivation).

**Changed (additive, all documentation-shape or new detector):**
- `SKILL.md` (top-level) is **deleted**; `package.json` `files` whitelist updates accordingly. The canonical agent skill lives only at `skills/secret-shuttle/SKILL.md`. Drift-guard test asserts the top-level file is absent.
- Three `agents/*.example.md` files are refreshed to use the Burst 5 verb surface.
- `examples/stripe-to-vercel/walkthrough.md` gains a top-of-file "Magic path" section using `provision --secret … --from capture --url … --to vercel:production`. The existing low-level content moves below under "Advanced: low-level mechanics" — preserved as escape-hatch documentation.
- README header banner is rewritten to honest-but-not-scary v0.3.1 framing.
- README gains a positioning section ("Why not Doppler / Infisical / 1Password CLI / Vercel envs?") between the hero and the Quickstart, with a 4-row comparison table.
- `demo/index.html` gains a new **Scene 0** at the front showing the `provision --infer → approve → audit` flow. Existing scenes renumber (or remain numbered with a section divider labeling them "Advanced: low-level mechanics"). The README hero embed updates to point at the demo URL with Scene 0 as the entry point.
- `--infer` gains a Supabase detector: signal `supabase/config.toml`, project_ref read from `.supabase/project.json` (`"ref"` field), graceful fallback to a needs_edit message when project hasn't been `supabase link`-ed yet. The detector routes **per-secret**, gated by a name predicate (`SUPABASE_*` regex + opt-in `infer.supabaseNames` override), so unrelated secrets like Stripe webhooks don't get over-routed to Supabase when both detectors fire.

### Trust model — unchanged

No new attack surface. Every change in this burst is either documentation, demo-page HTML, or read-only filesystem inspection during `--infer`. The Supabase detector reads `.supabase/project.json` but never reads or writes secret values; it only extracts the public project_ref identifier.

### Items map

| Item | Section | Surface |
|---|---|---|
| A | §1 | Documentation drift fixes (SKILL.md, agents/, walkthrough) |
| B | §2 | `--infer` Supabase detector (signal + project_ref resolution) |
| C | §3 | Positioning section in README (why-not comparison) |
| D | §4 | Demo refresh — new opening Scene 0 |
| E | §5 | W.1 dogfood pass — fresh-agent Next.js + Supabase walkthrough |

---

## §1 — Documentation drift fixes

### §1.1 — Top-level `SKILL.md` deletion + drift guard

**Problem:** the repo ships TWO `SKILL.md` files (top-level + `skills/secret-shuttle/SKILL.md`); `package.json` `files` whitelist includes both, so both reach npm consumers. The Burst 5 §3 restructure only updated the in-skills/ copy. The top-level one still contains the removed `bootstrap` verb in its quickstart.

**Fix:**
- Delete `SKILL.md` (top-level).
- Update `package.json` `files` array: remove the `"SKILL.md"` entry (keep `"skills/secret-shuttle/SKILL.md"` which is the canonical one).
- Add a drift-guard test asserting top-level `SKILL.md` does NOT exist (prevents accidental re-introduction by future PRs).
- Update any internal references (grep `rg -n "^SKILL.md\b|\bSKILL.md\b" --type md` for any link pointing at the top-level file).

**Out of scope:** no symlink, no copy script. Single source of truth.

### §1.2 — `agents/AGENTS.md.example` refresh

**Problem:** says `secret-shuttle daemon start && secret-shuttle unlock`. That's the legacy two-command setup ritual. Burst 5 §1 made `npx secret-shuttle init` the canonical setup.

**Fix:** replace the setup block with `npx secret-shuttle init`. The security-rules section ("Never ask the user to paste raw secrets," "Use refs like `ss://stripe/prod/STRIPE_WEBHOOK_SECRET`," etc.) is still accurate — keep it verbatim.

### §1.3 — `agents/codex-instructions.example.md` refresh

**Problem:** uses removed `secret-shuttle generate --name X --env prod --kind random_32_bytes --allow-domain vercel.com`.

**Fix:** replace with the canonical Burst 5 flow:

```bash
secret-shuttle provision --secret INTERNAL_CRON_SECRET \
  --from random_32_bytes \
  --environment production \
  --to vercel:production
```

Audit for any other stale flag references while in the file. Cross-check against the `secret-shuttle --help` output for the Burst 5 verb surface.

### §1.4 — `agents/cursor-rules.example.md` refresh

**Problem:** uses removed `secret-shuttle generate`.

**Fix:** same rewrite as §1.3.

### §1.5 — `examples/stripe-to-vercel/walkthrough.md` magic-path rewrite

**Problem:** the file currently shows the low-level `blind start` / `capture` / `inject` / `template run` rituals — pre-`provision` mental model. A user landing on this walkthrough today gets a 1990s-feeling 7-step ritual instead of the Burst 5 magic.

**Fix:**
- Insert a new top section "Magic path" using:

  ```bash
  secret-shuttle provision \
    --secret STRIPE_WEBHOOK_SECRET \
    --from capture --url https://dashboard.stripe.com/webhooks \
    --to vercel:production
  ```

  One block of text describing what the user sees in the hub (one approval card; click), one block showing the post-approval `provision --continue` resolving with `batch_status: completed` + audit row.

- Keep the existing low-level content below under a `## Advanced: low-level mechanics` header. It's still useful as escape-hatch documentation when a user needs to debug a capture flow step-by-step.

### §1.6 — README header banner rewrite

**Problem:** the README currently says

> **Status: 0.1.1 — early prototype. Do not trust this with real production secrets yet.**

A reader landing on the README sees that line BEFORE they see the "Let AI agents use secrets without seeing them" hero. The "do not trust" framing kills the page.

**Fix:** rewrite to honest-but-confident v0.3.1 framing:

> **Status: 0.3.1 — beta.** The architecture has been through six bursts of adversarial security review with fixes shipped. Not yet independently audited; use test accounts and rotating tokens until that audit lands. Suitable for development workflows and prototype deployment.

(Exact wording to be polished during implementation — the spec freezes the intent: confident-but-honest, not "early prototype." The version-string portion of the banner should land in the same commit as the `package.json` 0.3.1 bump (§6 wrap step) so the README never advertises a version newer than what `npm view` will resolve.)

### §1.7 — Tests

- Drift-guard for `SKILL.md` non-existence (§1.1).
- Existing `agent-install-no-leak.test.ts` already covers the canonical SKILL content shape — extend if necessary to assert the in-skills/ copy is what gets installed via `secret-shuttle agent install <runtime>`.
- **Removed-verb drift-guard test (new).** The discovery-surface stale-verb leakage that motivated this burst (`bootstrap` in top-level SKILL.md, `generate` in agent examples, `daemon start && unlock` ritual in AGENTS.md) must not silently regress. Add a `tests/docs-no-removed-verbs.test.ts` that:
  - Scans `skills/secret-shuttle/SKILL.md`, `agents/*.example.md`, `examples/stripe-to-vercel/walkthrough.md`, and `README.md`.
  - Asserts none of them contain the removed Burst 5 surface: the literal tokens `secret-shuttle generate`, `secret-shuttle bootstrap`, and `daemon start && secret-shuttle unlock` (and the `daemon start &&` prefix more broadly).
  - Has an allowlist for the *advanced/low-level* sections that intentionally preserve historical mechanics: `examples/stripe-to-vercel/walkthrough.md` below the `## Advanced: low-level mechanics` header may reference `secret-shuttle blind start`, `secret-shuttle capture`, `secret-shuttle inject`, `secret-shuttle template run` — those are the escape-hatch verbs and they remain canonical. The allowlist is scoped to that file/section only.
  - When the test fails, the error message names the offending file + line + token so the failure is self-explanatory.
- The README/walkthrough/agents-examples changes are text edits beyond the removed-verb drift-guard; visual review during the codex gate covers wording quality.

---

## §2 — `--infer` Supabase detector

### Goal

When `provision --infer` runs in a directory containing `supabase/config.toml`, the generated yml gains a `supabase:production` (or appropriate environment) destination **only for secrets that belong on Supabase**, with `template_params.project_ref` resolved to the linked cloud project ref if `.supabase/project.json` is present.

### Routing model (per-secret, not project-wide)

`--infer` produces a per-secret destination list, not a project-wide one — each secret in the generated yml gets its own `destinations:` array assembled by running every detector against that secret's name. The Supabase detector therefore needs an explicit name-matching predicate so it doesn't over-route unrelated secrets (Stripe webhook keys, cron tokens, etc.) onto Supabase.

**Name predicate (default):** the Supabase destination is attached to a secret if either:

1. The secret name matches the regex `^SUPABASE_[A-Z0-9_]+$` (e.g. `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`), OR
2. The secret name appears in an optional `infer.supabaseNames: string[]` field of `secret-shuttle.config.json` (escape hatch for projects that ship non-standard names like `DATABASE_SERVICE_KEY` to Supabase).

For any secret that doesn't match the predicate, the detector emits **no** Supabase destination for that secret, even when `supabase/config.toml` is present — the secret routes to whatever other detectors match (Vercel, Cloudflare, etc.). This avoids the "Supabase project exists, therefore every secret goes to Supabase" failure mode.

**`infer.supabaseNames` validation:** a config-supplied override entry is *accepted* only if it is a string that matches the regex `^[A-Z_][A-Z0-9_]*$` (uppercase letters, digits, and underscores, with a non-digit first character — the same env-var-safe shape secret names normally take). Any entry that fails this check — whether because it is not a string, or because it contains whitespace, control characters, lowercase letters, dots, dashes, a leading digit, or any other character outside the grammar — is rejected **per-entry**: the offending entry is dropped from the override list while valid entries in the same array still take effect. The detector emits a single `needs_edit` issue naming all offending entries (or their array indices, if non-string) and the config key so the user knows which overrides were ignored. The only case that drops the *whole* override is when the entire `infer.supabaseNames` value is not an array (e.g., a string or object at that key) — then the override is unusable as a whole, and a single `needs_edit` issue names the offending config key. This policy preserves valid overrides whenever possible (easier for users to recover from a typo in one entry) while still blocking malformed/dangerous secret names from silently slipping into routing decisions.

**Candidate vs final destinations:** the emitted Supabase destination is still considered a *candidate* — the generated yml is human-editable, and the README/walkthrough wording for `--infer` continues to say "review the generated yml before running `provision`". The detector's job is to populate the obvious case correctly, not to be infallible.

### Verified facts (from Supabase CLI docs, queried via context7)

- `supabase/config.toml` is created by `supabase init`. It contains a top-level `project_id` field, but that is a **local distinguisher** (defaults to the cwd basename) — NOT the cloud project_ref needed by `supabase-edge-secret-set`.
- The cloud project_ref lives in `.supabase/project.json`, with shape:
  ```json
  {
    "ref": "abcdefghijklmnopqrst",
    "name": "my-project",
    "fetchedAt": "2026-03-25T12:34:56.000Z",
    "versions": { "postgres": "...", "postgrest": "...", ... }
  }
  ```
- The file is written by `supabase link --project-ref <ref>`, refreshed by `supabase stack update`, removed by `supabase unlink`.
- The existing `supabase-edge-secret-set` template (verified during Burst 5 §2a) declares `sessionDefiningParams: ["name", "project_ref"]`. The detector must populate both.

### Detector behavior

The detector is evaluated **per-secret**. For each secret in the inference batch, the detector first runs the name predicate (see "Routing model" above). If the predicate doesn't match, the detector returns no destination for that secret regardless of on-disk state.

When the name predicate matches, the on-disk state determines the output:

| State on disk | Detector output (for a name-matching secret) |
|---|---|
| `supabase/config.toml` exists, `.supabase/project.json` exists with valid string `ref` of plausible shape | Emit `supabase:production` destination, `template_params: { name: "<secret_name>", project_ref: "<ref from project.json>" }` |
| `supabase/config.toml` exists, `.supabase/project.json` absent OR malformed JSON OR missing `ref` field OR `ref` is not a string | Emit destination with `template_params.project_ref: "TODO_run_supabase_link_first"` + add a `needs_edit` issue: *"Supabase target detected (`supabase/config.toml` present) but project not linked. Run `supabase link --project-ref <ref>` first, then re-run `provision --infer`."* |
| `supabase/config.toml` absent | No Supabase destination emitted |

The `ref` field's "plausible shape" check: at minimum `typeof === "string"` and length > 0. Stricter validation (e.g., 20-char lowercase) can be added if Supabase project refs have a stable grammar — to be verified during implementation; default to lenient.

### Sub-tasks

| # | Task |
|---|---|
| 2.1 | Locate the existing inference module (`src/cli/bootstrap/infer.ts` or wherever §1 placed it) and read its current detector shape. Each detector contributes `InferredDestination[]` to the assembled yml. |
| 2.2 | Implement `detectSupabase({ cwd, secretName, inferConfig })` per the routing model above. The detector evaluates the name predicate first (regex `^SUPABASE_[A-Z0-9_]+$` OR `secretName ∈ inferConfig.supabaseNames`) and returns `{ destinations: [], issues: [] }` (no Supabase destination) when the predicate fails — even if `supabase/config.toml` is present. When the predicate matches, the detector returns inferred destinations + any `needs_edit` issues based on the on-disk state table above. Safe file reads (existsSync → readFile → JSON.parse with try/catch). Sanitize the override list per the "Validation" rule above: drop each individual entry that is non-string OR fails the `^[A-Z_][A-Z0-9_]*$` grammar (i.e., contains whitespace, control characters, lowercase letters, dots, dashes, a leading digit, or other non-grammar characters); valid entries in the same array still take effect. Emit a single `needs_edit` issue naming all offending entries (or their indices, if non-string) + config key so the user knows which overrides were ignored. Only if the entire `infer.supabaseNames` value is not an array, drop the whole override and emit a single `needs_edit` issue naming the config key. |
| 2.3 | Integrate into the inference pipeline. Same call shape as the existing Vercel / Cloudflare detectors. |
| 2.4 | Tests: seven fixtures — (a) linked project with valid `ref` + secret named `SUPABASE_SERVICE_ROLE_KEY` (emits Supabase destination), (b) project with `config.toml` but no `project.json` + matching secret name (emits destination with `TODO_run_supabase_link_first` + needs_edit), (c) project with `config.toml` and malformed `project.json` + matching name (same as b), (d) project without `config.toml` (no destination emitted), (e) linked project + non-matching secret name like `STRIPE_WEBHOOK_SECRET` (no Supabase destination emitted — confirms name predicate gates routing), (f) linked project + non-matching secret name listed in `infer.supabaseNames` config override (emits destination — confirms escape hatch works), (g) linked project + invalid `infer.supabaseNames` config with three sub-cases: (g.1) array mixing a valid entry (`"MY_VALID_NAME"`) with entries containing whitespace/control chars/lowercase/dots/dashes AND an entry with a leading digit (e.g., `"1BAD_SECRET"`) — assert only offending entries are dropped (including the leading-digit entry), the valid entry still routes, and one `needs_edit` issue names all offending entries + config key; (g.2) array mixing a valid string entry with a non-string entry (e.g., `123` or `null`) — assert non-string entry is dropped, valid entry still routes, one `needs_edit` issue names the offending index + config key; (g.3) entire `infer.supabaseNames` value is not an array (e.g., a string `"FOO"`) — assert the whole override is dropped and one `needs_edit` issue names the config key. Assert correct output shape including needs_edit issues across all fixtures. |

### Out of scope (deferred)

- Render, Netlify, Railway, Fly, Firebase detectors. Each requires a corresponding template (none exist yet for those platforms). Templates ship in a later burst; detectors follow. Decision: per the scoping clarification, this burst only adds detectors for platforms with existing templates.

---

## §3 — Positioning section in README

### Goal

A reader landing on the README sees, between the hero and the Quickstart, a concise answer to *"why this tool and not Doppler / Infisical / 1Password CLI / Vercel envs?"* — enough that they can make an adopt/skip decision in 30 seconds.

### Content (~25 lines added to README)

Inserted between the hero ("Let AI agents use secrets without seeing them") and the existing `## 30-Second Install` section:

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

### Boundaries

- Stays scannable: one paragraph framing, one 4-row table, one paragraph "when to adopt." No deep links into multi-page comparison docs.
- The table's "Who sees plaintext" column for Secret Shuttle says "Only the daemon's child processes (templates)" — accurate per the trust model.
- The "Agent-aware?" column is the differentiator. Other tools may eventually add agent integrations; that's fine, the column states a fact about today's behavior.

### Test posture

Text edit only. No drift-guard test for the comparison table content (factual claims about other vendors can shift over time and shouldn't fail CI). The README's existing rendering / link-check via the discoverability test continues to apply.

---

## §4 — Demo refresh: add Scene 0 (magic-path)

### Goal

The existing demo at `pdumicz.github.io/secret-shuttle/demo/` (sourced from `demo/index.html`) shows 9 scenes of the low-level `blind start` / `capture` / `inject` flow. A user landing there from the README hero sees impressive technology but not the *Burst 5 magic moment*. A new opening Scene 0 makes the magic-path the first thing they encounter.

### Scene 0 content

Three beats, ~15 seconds total:

1. **Terminal pane (left):** agent runs `secret-shuttle provision --infer`. The generated yml streams in. Agent then runs `provision` (no flags — auto-picks the just-written yml). Terminal output shows `approval_required` with `batch_id` + `details.approvals[0]`.
2. **Hub approval card (right):** appears with the session-affordance checkbox visible ("Also approve any matching shape for the next 15 min"). User clicks Approve.
3. **Terminal pane (left, resuming):** agent runs `provision --continue --batch <id> --approval-id <id>`. Output shows successful pushes to vercel:production, supabase:production. Final terminal command: `audit --since 1m --json` — agent pastes the resulting JSON back to the user as proof.

### Demo file shape

`demo/index.html` is a single ~1870-line self-contained HTML+CSS+JS file. Existing scenes use:

- `.scene-stage[data-scene="N"]` for layout
- `.scene-meta.active` for current-scene captions
- A JS scene-navigation function that advances on click

The new Scene 0 follows the same pattern — adds:
- `.scene-stage[data-scene="0"]` CSS block with the terminal-left/approval-right layout
- `.scene-meta` block with the Scene 0 caption text
- HTML markup for the new terminal pane + approval card

Existing scenes 1-9 **must stay numbered as 1-9** — Scene 0 is prepended as a new entry, not renumbered into the sequence. This preserves every external `?scene=N` deep link to scenes 1-9 (the demo is publicly linked from the README and may be linked from elsewhere). A section divider in the scene-meta listing labels scenes 1-9 as "Advanced: low-level mechanics" to make the magic-path (Scene 0) versus advanced split visually clear. Renumbering 0-9 → 1-10 is explicitly NOT permitted — it would silently break any in-flight deep link.

### README hero embed update

The current README has:

```markdown
[**▶ Walk through the demo →**](https://pdumicz.github.io/secret-shuttle/demo/)
```

Update to:

```markdown
[**▶ Walk through the demo →**](https://pdumicz.github.io/secret-shuttle/demo/?scene=0)
```

…assuming the demo's scene-navigation honors a `?scene=N` query param. If it doesn't, add that parsing during implementation (small JS addition).

### Effort estimate

~2 hours: ~1 hour for the HTML/CSS scene block, ~1 hour for the scene-navigation logic + query-param honoring + verification.

---

## §5 — Dogfood pass + friction log

### Goal

Validate that a fresh agent session, pointed at a real-world Next.js + Stripe + Supabase project, can complete the full `provision → continue → audit` cycle using ONLY the Burst 5/6 surface, without prior context.

### Process (user-driven, not subagent-driven)

1. Spin up a fresh test project. Suggested: `npx create-next-app@latest`, add `npm install stripe @supabase/supabase-js`. Run `supabase init` + `supabase link --project-ref <a real test project>`. Add `.env.example` with entries for `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_CRON_SECRET`.
2. Start a fresh Claude Code session in that project root. No prior context, no pre-installed agent skills.
3. First prompt: *"Set up secret-shuttle in this project. I need a Stripe webhook secret pushed to Vercel production and a Supabase service-role key pushed to Supabase production. The Stripe one I need to capture from the Stripe dashboard."*
4. Observe and time the session. Note every place the agent:
   - Pauses to ask the human something (legitimate consent moments vs avoidable friction)
   - Recovers from a stumble (error code lookup, retry path)
   - Succeeds smoothly (magic moments — flag these too)
5. Write notes into `docs/dogfood/2026-06-XX-burst6-notes.md` with sections:
   - **Worked well** — moments the agent flew
   - **Friction** — where the agent paused, asked, or recovered
   - **Bugs** — anything that errored or behaved unexpectedly
   - **Polish backlog** — v0.3.2 / v0.4.0 items the friction reveals
6. Commit the notes file.

### Burst 6 deliverable: a template file ready to fill in

`docs/dogfood/burst6-template.md` ships in this burst pre-populated with the four section headers and a quick-reference card for the user. **That template file IS the Burst 6 deliverable.** Filling it in is the user's actual dogfood step, which happens AFTER Burst 6 lands and BEFORE the 0.3.1 `npm publish`.

### Pass criteria (for the human release gate, not for Burst 6 itself)

The dogfood run is a separate human release gate — its outcome gates 0.3.1 publish but does NOT gate Burst 6 completion or merge. The Burst 6 implementation is "done" when the template ships, the code changes land, and the codex impl-stage gate is clean. The dogfood run is the *next* step after that, owned by the user.

Two distinct buckets apply to the dogfood run: a **release-blocker gate** (the only thing that decides whether 0.3.1 ships) and **UX target metrics** (informational — they track polish quality but do not block publish on their own).

**Release-blocker gate (the actual publish gate — ALL must hold):**

If every bullet below holds, `npm publish 0.3.1` is unblocked. If *any* bullet fails, publish is blocked until the underlying issue is fixed and the dogfood run is repeated.

- The agent reaches a successful `audit --since 5m` showing both Stripe + Supabase secrets pushed end-to-end, with **at most one human approval click** (the single batch approval).
- The single-batch-approval invariant holds — more than one approval click would block; the approval UI rendered correctly.
- No secret value is exposed in any log, audit row, or UI surface visible to the agent.
- The audit log shows correct attribution (correct agent_id, correct batch_id, all required fields present).
- The agent did not need to read source code or internal docs to recover from a failure (i.e., no hard error or hang that required user spelunking).

If any of the above fails, the user does NOT publish 0.3.1. The fix lands as a Burst 6 follow-up commit (or a Burst 7 task if it's architectural), and the dogfood run is repeated until the release-blocker gate is clean.

**UX target metrics (tracked, NOT release-blocking):**

These are the polish goals — they tell us how close the magic-path actually is to the Burst 5/6 vision. Missing a target logs an item to the v0.3.2 backlog but does *not* block 0.3.1 publish on its own:

- **Zero clarifying questions:** the agent reached `audit --since 5m` without asking the human "how do I do X" beyond the initial single prompt. A clarifying question the human can answer in one sentence is a polish miss, not a publish blocker.
- **Under 5 minutes wall-clock:** total time from "first prompt" to "audit success" is under 5 minutes (excluding the human's approval-click decision time). Going over the target is a polish miss, not a publish blocker.
- **No polish gaps surfaced:** wording, demo presentation, README phrasing all read clean during the run. Polish gaps that don't affect correctness are polish misses, not publish blockers.

UX target misses are filed as v0.3.2 backlog items in `docs/dogfood/2026-06-XX-burst6-notes.md`'s "Polish backlog" section. They do not gate the release — the discovery-surface fixes are what gates 0.3.1, and the release-blocker gate above is the only thing that decides "ship vs hold."

---

## §6 — Implementation order

Sequential primary path, with parallelization opportunities flagged:

| Order | Section | Notes |
|---|---|---|
| 1 | §1.1 — Delete top-level `SKILL.md`, update `package.json`, add drift-guard | Lowest-risk start. Single delete + 2-line edit + 1 new test. |
| 2 | §1.2, §1.3, §1.4 — `agents/*.example.md` refresh (3 files) | **Parallel subagent opportunity** — files are touch-independent. Three subagents in one batch. |
| 3 | §1.6 — README header banner | Independent README edit. |
| 4 | §3 — README positioning section | Lands as a single commit alongside §1.6 (both touch README). |
| 5 | §1.5 — `walkthrough.md` magic-path rewrite | Larger doc rewrite. Sequential after §1.2-1.4 so the verb-name canonicalization is stable. |
| 6 | §2 — Supabase detector | TDD: fixtures first, then `detectSupabase`, then integration. |
| 7 | §4 — Demo Scene 0 | **Can parallelize with §2** — HTML/CSS work is touch-independent. |
| 8 | §5 — Dogfood template file | Ship `docs/dogfood/burst6-template.md` with the four section headers + quick-reference card. The actual dogfood RUN is a post-burst human release gate (see §5 pass criteria), not a burst step. |
| 9 | Wrap — CHANGELOG entry, `0.3.1` version bump, codex review gate (impl stage). Leaves repo in publish-ready state; `npm publish` + `git tag v0.3.1` + `git push --tags` happen after the user's dogfood run passes. | Mirrors Burst 5 W.2; defers W.3 (publish/tag/push) to the post-burst release gate. |

### Parallelization summary

- Batch A (after §1.1): three subagents on §1.2/1.3/1.4 + one subagent on §3.
- Batch B (after §1.5): one subagent on §2 + one subagent on §4.
- Sequential: §1.1, §1.5, §5, Wrap.

---

## §7 — Out of scope (Burst 7 forward-reference)

These items are scoped here so the reader knows what's coming next, but their deep design happens inside Burst 7's own brainstorm cycle.

### §7.A — Plan 5a: Native keychain adapter

- **Problem:** passphrase entry every daemon restart is friction. Today, after first vault creation, every subsequent daemon spawn requires the user to re-enter the passphrase in the browser UI. Plan 5a replaces the typed `keychain_not_implemented` stubs in `src/vault/keychain/` with real per-platform implementations.
- **Recommended library:** `@napi-rs/keyring` (cross-platform: macOS keychain via Security framework, Linux secret-service via D-Bus, Windows Credential Manager). Named in Burst 4 CHANGELOG as the canonical choice.
- **Known unknowns to resolve during Burst 7 brainstorm:**
  - Error handling when keychain access is denied (user clicks Cancel on the OS prompt) — fall back to passphrase UI? Throw a typed error?
  - Cross-machine vault migration story (export → import workflow).
  - Password rotation flow (user changes vault passphrase — keychain entry refresh).
- **Effort estimate:** ~3 days.

### §7.B — Plan 5s: Per-project agent IDs

- **Problem:** today all projects on a machine share the same `<runtime>-<machineid>` agent identity. Owner-enforced consumption (Burst 4) can't distinguish "agent in project A" from "agent in project B" — they're the same actor. A session-affordance leak in one project would let the same agent ID consume sessions in another project.
- **Recommended approach:** derive per-project agent ID from the cwd's git-repo-root path (fallback: cwd path when not in a git repo). HMAC the path using the existing machine-id HMAC infrastructure so it's stable but unguessable.
- **Known unknowns to resolve during Burst 7 brainstorm:**
  - Monorepo behavior (one git root, many sub-projects) — do all sub-projects share an ID, or is it cwd-derived even within a repo?
  - Opt-in vs default — should the per-project derivation be the default, or opt-in via flag?
  - Project relocation (user moves the project on disk — git root path changes, agent_id changes, existing sessions/grants now orphaned).
- **Effort estimate:** ~2 days.

### §7.C — Plan 5q: Buffer refactor for plaintext-in-memory hygiene

- **Problem:** `Secret.value` and `CaptureResult.value` are JS strings. JS strings are immutable and linger in heap until GC. The product's "daemon never lets plaintext leak" guarantee is weakened at the heap level — a heap dump or core file from the daemon process would contain recently-handled secret values.
- **Recommended approach:** change boundary types from `string` to `Buffer` everywhere the secret bytes flow. Scrub the Buffer after consumption (overwrite then release). Wire protocol can keep stringifying — the gain is in-memory representation, not wire shape.
- **Known unknowns to resolve during Burst 7 brainstorm:**
  - How many call sites? Probably hundreds (every `secret.value` read).
  - Conversion overhead at the JSON/HTTP boundary.
  - Whether the existing best-effort scrubbing in `Vault.read`/`write` conflicts with the Buffer-everywhere model or supersedes it.
- **Effort estimate:** ~3–5 days depending on call-site count.

### §7.D — CI/CD story (may want its own burst)

- **Problem:** the daemon runs LOCALLY on a developer's machine. CI runners don't have a local daemon. The end-to-end loop "agent provisions secrets → ships code to GitHub → CI tries to deploy with those secrets → CI runner has no vault → fails" breaks at the CI boundary.
- **Possible directions (Burst 7 brainstorm picks one):**
  1. Short-lived service-account tokens minted from the daemon into CI runner env (token has scoped read access for one workflow run).
  2. "Sealed CI mode" — the daemon runs IN a CI container with a single-shot vault unlock at the start of a workflow (deploy-key style).
  3. Bridge mode — secrets sync as a per-project encrypted blob to a side-channel (S3, GitHub Secrets, etc.) that CI pulls and decrypts with a deploy key.
- **Known unknowns to resolve during Burst 7 brainstorm:**
  - Trust model for tokens-in-CI (revocation, blast radius).
  - Audit attribution in CI (whose agent_id is the CI runner?).
  - Multi-environment deploys (CI might deploy to staging AND prod from one workflow).
- **Effort estimate:** TBD pending design. Possibly its own Burst 8 if it goes deep.

### §7.E — Render / Netlify / Railway / Fly / Firebase detectors

- Each detector requires a corresponding template (none exist yet for these platforms).
- Template build cost: ~2-3 hours each (binary validation, argv stability, audit shape, tests) plus the ~30-min detector signal.
- Total deferred work: ~3 days for all five platforms.
- Burst 7 (or later) scope decision — should consider which platforms vibe coders actually ship to most.

---

## §8 — Success criteria for Burst 6

This burst is successful if all of the following are true:

1. **Dogfood template ships (§5):** `docs/dogfood/burst6-template.md` exists with the four section headers + quick-reference card, ready for the user to fill in during the post-burst release gate. (The actual dogfood run is a separate human gate that blocks `npm publish 0.3.1`, NOT Burst 6 merge.)
2. **Supabase detector works (§2):** `secret-shuttle provision --infer` on a Next.js + Supabase project emits a yml that attaches `supabase:production` destinations only to secrets matching the Supabase name predicate (`SUPABASE_*` or configured names), and attaches `vercel:production` to the others. `project_ref` populated correctly when the project is `supabase link`-ed; `needs_edit` message correct when not. Unit tests cover the seven fixtures from §2.4 (linked + matching name; linked + non-matching name; unlinked + matching name; malformed JSON + matching name; no config.toml; configured-names override; invalid-config override).
3. **Positioning section lands (§3):** the README's "Why not Doppler / 1Password / etc." section answers the question in a way the user can paste verbatim to a vibe coder without further explanation.
4. **Demo Scene 0 lands (§4):** the demo's opening scene shows the magic-path within 15 seconds of opening the demo URL.
5. **Documentation drift is gone (§1):** top-level `SKILL.md` deleted; all `agents/*.example.md` use the Burst 5 verb surface; walkthrough leads with the magic path. The removed-verb drift-guard test (§1.7) passes.
6. **v0.3.1 is ready to publish:** `package.json` version bumped to `0.3.1`, CHANGELOG entry written. The actual `npm publish` is gated on the dogfood run (criterion 1's release gate) and is therefore out of Burst-6-completion scope — but the burst leaves the repo in a publishable state.
7. **Codex review gate passes:** the impl-stage codex gate over the Burst 6 diff returns clean (or with only acknowledged P3 findings).

---

## §9 — Risks

| Risk | Mitigation |
|---|---|
| README rewrite changes break existing external links pointing at section anchors | Search GitHub for inbound links via `link:github.com/pdumicz/secret-shuttle` (web search); preserve any in-use anchors during the rewrite. If anchors must change, redirect via the existing top of file. |
| Supabase `.supabase/project.json` schema drift over time (new fields, removed fields) | Read defensively — extract `ref` field only, ignore everything else. Test the malformed-JSON path. |
| Demo Scene 0 breaks existing `?scene=N` deep links by renumbering | §4 mandates "preserve existing scene numbers; prepend Scene 0" — renumbering 0-9 → 1-10 is explicitly disallowed. Deep links to scenes 1-9 keep working by construction. |
| Dogfood pass reveals a real bug that isn't a quick patch | Classify by the §5 release-blocker gate: failing any release-blocker bullet (cannot reach `audit --since 5m`, single-approval invariant violated, secret value leaked, audit attribution wrong, agent had to spelunk source/docs to recover) blocks 0.3.1 publish until fixed — patch as a Burst 6 follow-up commit (or escalate to Burst 7 if architectural) and re-run dogfood. UX target misses (clarifying questions, time over 5 min, polish gaps) are logged as v0.3.2 backlog and 0.3.1 ships anyway. The user does not decide "blocker vs polish" by feel — the §5 release-blocker gate decides. |
| `--infer` Supabase detector misfires on a project that has `supabase/config.toml` but isn't ACTUALLY a Supabase Edge Functions consumer | The name-predicate (`SUPABASE_*` regex + opt-in `infer.supabaseNames` override) gates routing per-secret: only secrets whose names match get a Supabase destination, so Stripe/cron/other secrets stay routed to Vercel even when `config.toml` is present. The needs_edit message handles the unlinked case. For the residual case where a user has supabase locally + a matching name but doesn't want a destination, they can edit the generated yml — same as today's vercel.json false-positives. |
| npm publish gates on credentials we don't have | Already on the user's plate per Burst 5 W.3. This burst doesn't change the publish ritual. |

---

## §10 — Self-review notes (for the spec writer)

This spec covers:
- §1 — 6 documentation drift fixes ✓
- §2 — Supabase detector with two-file resolution ✓
- §3 — README positioning section ✓
- §4 — Demo Scene 0 ✓
- §5 — Dogfood pass + template file ✓
- §6 — Implementation order with parallelization map ✓
- §7 — Burst 7 forward-reference (5a, 5s, 5q, CI/CD, deferred platform detectors) ✓
- §8 — 7 testable success criteria ✓
- §9 — 6 risks with mitigations ✓

No placeholders. No internal contradictions: dogfood-run is a post-burst human release gate (not a Burst 6 deliverable); only the template file ships in this burst. Supabase detector routing is explicitly per-secret via a name predicate, not project-wide. README banner version is `0.3.1` to match the publish target, landed alongside the `package.json` bump. Scope appropriate for a single execution plan. Wording of the README banner sentence intentionally left to implementation (intent + version-string are frozen, prose is flexible).

This spec is the input to the next-stage writing-plans skill invocation.
