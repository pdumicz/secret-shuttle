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
- README header banner is rewritten to honest-but-not-scary v0.3.0 framing.
- README gains a positioning section ("Why not Doppler / Infisical / 1Password CLI / Vercel envs?") between the hero and the Quickstart, with a 4-row comparison table.
- `demo/index.html` gains a new **Scene 0** at the front showing the `provision --infer → approve → audit` flow. Existing scenes renumber (or remain numbered with a section divider labeling them "Advanced: low-level mechanics"). The README hero embed updates to point at the demo URL with Scene 0 as the entry point.
- `--infer` gains a Supabase detector: signal `supabase/config.toml`, project_ref read from `.supabase/project.json` (`"ref"` field), graceful fallback to a needs_edit message when project hasn't been `supabase link`-ed yet.

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

**Fix:** rewrite to honest-but-confident v0.3.0 framing:

> **Status: 0.3.0 — beta.** The architecture has been through five bursts of adversarial security review with fixes shipped. Not yet independently audited; use test accounts and rotating tokens until that audit lands. Suitable for development workflows and prototype deployment.

(Exact wording to be polished during implementation — the spec freezes the intent: confident-but-honest, not "early prototype.")

### §1.7 — Tests

- Drift-guard for `SKILL.md` non-existence (§1.1).
- Existing `agent-install-no-leak.test.ts` already covers the canonical SKILL content shape — extend if necessary to assert the in-skills/ copy is what gets installed via `secret-shuttle agent install <runtime>`.
- The README/walkthrough/agents-examples changes are text edits and don't need automated tests, but visual review during the codex gate covers them.

---

## §2 — `--infer` Supabase detector

### Goal

When `provision --infer` runs in a directory containing `supabase/config.toml`, the generated yml gains a `supabase:production` (or appropriate environment) destination, with `template_params.project_ref` resolved to the linked cloud project ref if `.supabase/project.json` is present.

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

| State on disk | Detector output |
|---|---|
| `supabase/config.toml` exists, `.supabase/project.json` exists with valid string `ref` of plausible shape | Emit `supabase:production` destination, `template_params: { name: "<secret_name>", project_ref: "<ref from project.json>" }` |
| `supabase/config.toml` exists, `.supabase/project.json` absent OR malformed JSON OR missing `ref` field OR `ref` is not a string | Emit destination with `template_params.project_ref: "TODO_run_supabase_link_first"` + add a `needs_edit` issue: *"Supabase target detected (`supabase/config.toml` present) but project not linked. Run `supabase link --project-ref <ref>` first, then re-run `provision --infer`."* |
| `supabase/config.toml` absent | No Supabase destination emitted |

The `ref` field's "plausible shape" check: at minimum `typeof === "string"` and length > 0. Stricter validation (e.g., 20-char lowercase) can be added if Supabase project refs have a stable grammar — to be verified during implementation; default to lenient.

### Sub-tasks

| # | Task |
|---|---|
| 2.1 | Locate the existing inference module (`src/cli/bootstrap/infer.ts` or wherever §1 placed it) and read its current detector shape. Each detector contributes `InferredDestination[]` to the assembled yml. |
| 2.2 | Implement `detectSupabase(cwd)`: returns inferred destinations + any `needs_edit` issues. Safe file reads (existsSync → readFile → JSON.parse with try/catch). |
| 2.3 | Integrate into the inference pipeline. Same call shape as the existing Vercel / Cloudflare detectors. |
| 2.4 | Tests: four fixtures — (a) linked project with valid `ref`, (b) project with `config.toml` but no `project.json`, (c) project with `config.toml` and malformed `project.json`, (d) project without `config.toml`. Assert correct output shape including needs_edit issues. |

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

Existing scenes 1-9 either stay numbered (with a section divider in the scene-meta listing labeling them "Advanced: low-level mechanics") OR renumber 0-9 → 1-10. The cleaner choice (preserve existing scene numbers, add Scene 0 as a prepended entry) avoids breaking external `?scene=N` deep links.

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

`docs/dogfood/burst6-template.md` ships in this burst pre-populated with the four section headers and a quick-reference card for the user. Filling it in is the user's actual dogfood step.

### Pass criteria

The dogfood passes if:
- The agent gets to a successful `audit --since 5m` showing both Stripe + Supabase secrets pushed, with **at most one human approval click** (the single batch approval).
- No friction point requires the agent to read a manual or ask the human "how do I do X" beyond the initial single prompt.
- Total wall-clock time from "first prompt" to "audit success" is under 5 minutes (excluding the human's approval-click decision time).

If the dogfood fails (an agent gets stuck, has to ask follow-up questions, hits an unexpected error), Burst 6 isn't done — we patch and re-run.

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
| 8 | §5 — Dogfood pass | Runs AFTER 1-7 land. Validates the surface. User-driven. |
| 9 | Wrap — CHANGELOG entry, `0.3.1` version bump, codex review gate (impl stage), `npm publish`, `git tag v0.3.1`, `git push --tags` | Mirrors Burst 5 W.2/W.3 exactly. Codex gate covers the §1-§4 diff. |

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

1. **Dogfood passes (§5):** a fresh Claude Code session pointed at a Next.js + Stripe + Supabase project completes `provision → continue → audit` with at most one human approval click, no manual lookups, under 5 minutes wall-clock.
2. **Supabase detector works (§2):** `secret-shuttle provision --infer` on that same project emits a yml containing BOTH `vercel:production` AND `supabase:production` destinations. `project_ref` populated correctly when the project is `supabase link`-ed; `needs_edit` message correct when not.
3. **Positioning section lands (§3):** the README's "Why not Doppler / 1Password / etc." section answers the question in a way the user can paste verbatim to a vibe coder without further explanation.
4. **Demo Scene 0 lands (§4):** the demo's opening scene shows the magic-path within 15 seconds of opening the demo URL.
5. **Documentation drift is gone (§1):** top-level `SKILL.md` deleted; all `agents/*.example.md` use the Burst 5 verb surface; walkthrough leads with the magic path.
6. **v0.3.1 is published:** `npm publish` succeeded; `npx secret-shuttle@0.3.1 --help` from a clean machine returns the agent-quickstart line + verb list including `provision` and `audit`.
7. **Codex review gate passes:** the impl-stage codex gate over the Burst 6 diff returns clean (or with only acknowledged P3 findings).

---

## §9 — Risks

| Risk | Mitigation |
|---|---|
| README rewrite changes break existing external links pointing at section anchors | Search GitHub for inbound links via `link:github.com/pdumicz/secret-shuttle` (web search); preserve any in-use anchors during the rewrite. If anchors must change, redirect via the existing top of file. |
| Supabase `.supabase/project.json` schema drift over time (new fields, removed fields) | Read defensively — extract `ref` field only, ignore everything else. Test the malformed-JSON path. |
| Demo Scene 0 breaks existing `?scene=N` deep links by renumbering | Preserve existing scene numbers; add Scene 0 as a prepended entry. Deep links to scenes 1-9 keep working. |
| Dogfood pass reveals a real bug that isn't a quick patch | If a bug is small, fix and re-run. If it's an architectural issue, document as a v0.3.2 backlog item and let 0.3.1 ship without it (the discovery-surface fixes are the gating value). |
| `--infer` Supabase detector misfires on a project that has `supabase/config.toml` but isn't ACTUALLY a Supabase Edge Functions consumer | The needs_edit message handles the unlinked case. For the case where a user has supabase locally but doesn't want a destination, they can edit the generated yml — same as today's vercel.json false-positives. |
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

No placeholders. No internal contradictions. Scope appropriate for a single execution plan. Ambiguity in the README banner text intentionally left to implementation (intent is frozen, wording is flexible).

This spec is the input to the next-stage writing-plans skill invocation.
