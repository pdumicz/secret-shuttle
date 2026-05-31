# Secret Shuttle Agent Onboarding — Design (Spec C)

**Date:** 2026-05-31
**Status:** Design
**Follow-up to:** `docs/superpowers/specs/2026-05-30-secret-shuttle-honesty-pass-design.md` ("Out of scope / follow-ups", item 5: agent onboarding — discovery + mid-session reload).

## Goal

Make the canonical agent skill **discoverable** (add YAML frontmatter so Claude Code can auto-load it by `description`) and **correctly framed per install target** (Claude skill, Cursor `.mdc` rule, Codex/Copilot always-loaded snippets), plus a **one-line behavioral nudge** that keeps an agent from acting on a stale in-session copy of the skill.

One sentence: teach agents to find the skill, frame it right for each tool, and remind them the on-disk file is the source of truth.

## Background

`skills/secret-shuttle/SKILL.md` is the canonical operating manual. `secret-shuttle agent install <target>` and `secret-shuttle init` both write it into a project so the agent can read it. Three gaps:

1. **Discovery.** The canonical SKILL.md has **no YAML frontmatter** — it opens directly with `# Secret Shuttle`. Claude Code matches a skill's frontmatter `description` to decide when to auto-load it; with no `description`, the skill cannot be auto-discovered. An empirical survey of 18 installed skills found 17/18 carry `name` + `description` frontmatter; secret-shuttle is the lone exception.

2. **Framing.** Install copies the **full SKILL.md verbatim to all four targets** through one code path (`agentInstallTarget` in `src/cli/commands/agent.ts`). Each target wants different framing:
   - A **Claude skill** file (`.claude/skills/secret-shuttle/SKILL.md`) wants skill frontmatter (`name`/`description`).
   - A **Cursor rule** (`.cursor/rules/secret-shuttle.mdc`) wants Cursor's own `.mdc` frontmatter schema (`description`/`globs`/`alwaysApply`) — skill frontmatter is wrong there.
   - **Always-loaded snippet** targets (`AGENTS.md`, `.github/copilot-instructions.md`) are plain context files; YAML frontmatter injected mid-file is meaningless noise.

   So naively adding skill frontmatter and copying verbatim would leak YAML into the middle of `AGENTS.md`/Copilot files and emit malformed frontmatter for Cursor. Adding frontmatter and per-target framing must land together.

3. **Staleness.** Once a skill is loaded, it is cached for the session; if the on-disk file later changes (e.g., a verb is renamed in a new release), the agent may act on its stale in-session memory. The research conclusion (below) is that a heavyweight reload protocol is unwarranted; a one-line behavioral nudge covers the cheap case, and the **dangerous** case — calling a renamed/removed verb — is *already* caught at runtime by the `command_renamed` error_code + `next_action` contract.

### Research conclusion (why this scope, not more)

The honesty-pass follow-up originally imagined a "daemon version + staleness-reload protocol". Research into how successful skills are built (Anthropic Agent Skills docs + a survey of 18 installed skills) showed that approach is unprecedented and unnecessary:

- **Discovery is the frontmatter `description`.** Progressive disclosure pre-loads ~100 tokens of frontmatter at session start; the body loads on trigger; supporting files load on demand. Best practice: SKILL.md < 500 lines, `description` ≤ 1024 chars, "Use when…" trigger phrasing.
- **There is no version field for filesystem skills.** The versioning API is Claude-API-only, not Claude Code. 0/18 surveyed skills carry any version stamp, hash, or last-updated marker; 0/18 have reload/staleness machinery.
- **The only staleness pattern in the wild** is a plain-English line (e.g. using-superpowers' "I remember this skill → Skills evolve. Read current version.").

So this spec ships exactly: frontmatter + per-target framing + a one-line nudge. No daemon work, no version stamp, no staleness endpoint.

## Non-goals (explicitly out of scope)

- **No** daemon version field, `/staleness` endpoint, or reload protocol.
- **No** switch to concise per-target snippets: Codex/Copilot keep the full body (minus frontmatter). Trimming the body is a separate content-design effort (YAGNI here).
- **No** wiring of the curated `agents/*.example.md` reference files into install — they remain unused reference docs; this spec does not change that.
- **No** rewrite of the SKILL.md body beyond inserting the one-line nudge.

## Design

### 1. Canonical SKILL.md: frontmatter + nudge

Add YAML frontmatter to the top of `skills/secret-shuttle/SKILL.md`, derived from the existing opening two lines, using "Use when…" trigger phrasing:

```yaml
---
name: secret-shuttle
description: Use when an AI coding agent must provision, inject, run, or rotate secrets without ever seeing their plaintext — you work with ss:// refs (like ss://stripe/prod/STRIPE_WEBHOOK_SECRET) while a local daemon resolves the real value at the last possible moment.
---
```

(`description` is single-line, ~250 chars, well under the 1024 limit. Single-line is also what the per-target parser relies on by convention; multi-line YAML scalars are still parsed correctly because we use the `yaml` library, but authoring stays single-line.)

Insert a one-line **re-read nudge** as a blockquote immediately after the opening two-line description (after current line 4, before `## 30-second quickstart`):

```markdown
> Skills evolve. Treat this on-disk file — and live `status --json` / a command's `next_action` — as the source of truth over anything you remember from an earlier read.
```

No other body changes.

### 2. Per-target framing — single source of truth

Introduce a small, pure framing module, `src/cli/skill-frame.ts`. It is the one place that knows how to turn the raw bundled SKILL.md (frontmatter + body) into the correctly-framed content for each target.

**`splitFrontmatter(raw: string)`** → `{ data: Record<string, unknown> | null; body: string }`
- Detect a leading `---\n … \n---\n` block. If present, parse the inner YAML with the `yaml` package (already a dependency, `^2.9.0`) into `data`, and set `body` to everything after the closing fence. Trim leading blank lines from `body`.
- If the fence is present but the inner YAML fails to parse (or does not parse to an object), do **not** return `data = null` and silently fall through to body-only framing — instead throw `ShuttleError("skill_frontmatter_invalid", …)` (or surface the parse failure so `frameSkillForTarget` maps it to `skill_frontmatter_invalid`). A malformed-YAML block is a corruption signal, not an "absent frontmatter" case.
- If absent (no leading fence at all), `data = null`, `body = raw`.

**`frameSkillForTarget(target: AgentTarget, raw: string): string`**
- First validate: parse via `splitFrontmatter`. Wrap any YAML parse failure as `ShuttleError("skill_frontmatter_invalid", …)`. Then assert strict shape — fail-closed unless **all** hold:
  - `data` is a non-null object,
  - `typeof data.name === "string"` and `data.name.trim()` is non-empty,
  - `typeof data.description === "string"` and `data.description.trim()` is non-empty,
  - the **trimmed** `data.description` contains no `\r` or `\n` (single-line). An embedded newline would survive into the Cursor `.mdc` and break its single-line `description` contract (lines 93-110) even though `lineWidth: 0` prevents *wrapping* — `lineWidth` does not collapse author-supplied line breaks. Fail-closed here rather than emit a multi-line `.mdc` description.

  Any other case (null `data`, missing key, non-string value such as a number/array/object, whitespace-only string, or a `description` with an embedded `\r`/`\n`) throws `ShuttleError("skill_frontmatter_invalid", …)`. Use the **trimmed** `name`/`description` downstream (e.g. when emitting the Cursor `.mdc` description). A bundled skill that lost or corrupted its frontmatter must not silently install malformed output.
- Then branch by target:

| target | mode | framed output |
|---|---|---|
| `claude` | wholesale | the **raw** content unchanged (skill frontmatter + body) |
| `cursor` | wholesale | Cursor `.mdc` frontmatter built from the skill `description`, then the body |
| `codex` | snippet | the **body only** (skill frontmatter stripped) |
| `copilot` | snippet | the **body only** (skill frontmatter stripped) |

**Cursor `.mdc` frontmatter** is generated with `yaml.stringify` (so the description is correctly quoted/escaped) wrapped in fences, then a blank line, then the body. The Cursor `.mdc` is a **compatibility surface**, not arbitrary YAML data — it must match Cursor's documented rule shape (single-line `description`, blank `globs`, `alwaysApply: false`; see https://docs.cursor.com/context/rules), so the spec asserts the **exact emitted text**, not just parsed-YAML equivalence. The target shape:

```mdc
---
description: <trimmed skill-frontmatter description, on a single line>
globs:
alwaysApply: false
---

<body>
```

Generation constraints (because default `yaml.stringify` does not produce this shape):
- Call `yaml.stringify(..., { lineWidth: 0 })` so the long `description` stays on **one** line and never wraps into YAML continuation lines. The default 80-column wrap breaks Cursor's single-line expectation and conflicts with the single-line convention noted above.
- Emit `globs:` with no value (blank), matching Cursor's documented example — not `globs: ""`, `globs: null`, or an omitted key. This is the crux: with the repo's `yaml` package a plain object value does **not** naturally produce a blank `globs:` — `""` serializes to `globs: ""`, `null` to `globs: null`, and `undefined` omits the key entirely. So plain `yaml.stringify` of an object cannot emit the required shape. Use one of these concrete strategies (the literal-output test in Testing §3 is the contract that pins whichever is chosen):
  1. **Construct three-key frontmatter manually** — serialize only the `description` value via `yaml.stringify({ description }, { lineWidth: 0 })` (to get correct quoting/escaping for the long string), then assemble the block as that `description` line + a literal `globs:` line + `alwaysApply: false`. Preferred: it keeps YAML escaping for the one field that needs it while making the blank `globs` byte-exact.
  2. **AST-level YAML** — build a `yaml.Document`/map and set the `globs` node to a `yaml.Scalar` with an empty value (or `Scalar.PLAIN` empty), if that reliably renders `globs:` with no trailing space under the installed `yaml` version.
  3. **Narrow post-process** — `yaml.stringify` the object then deterministically rewrite the `globs` line to blank — acceptable only if covered by the literal-output test so a `yaml` upgrade can't silently regress it.
- Key order is `description`, `globs`, `alwaysApply`.

Tests for this target (see Testing §3) must assert the **literal `.mdc` text** (exact lines / a string match on the emitted frontmatter block), not only that the parsed YAML is equivalent — the byte shape is the contract Cursor consumes.

`alwaysApply: false` (decided): the rule is description-triggered ("Agent Requested" in Cursor's model) — Cursor loads it when it detects a secret-handling task, keeping context lean and matching the progressive-disclosure model the Claude target already uses. Blank `globs` (no path-based auto-attach) because the skill is task-scoped, not file-scoped.

### 3. Wiring

`agentInstallTarget(target, { skillContent, cwd })` (`src/cli/commands/agent.ts`) is the single path used by **both** `agent install <target>` and `init`'s `installAgentSkills`. Frame inside it, before the write:

```ts
const framed = frameSkillForTarget(target, opts.skillContent);
if (spec.mode === "wholesale") {
  await writeAgentFile({ targetPath: dest, content: framed });
} else {
  await writeAgentSnippet({ targetPath: dest, content: framed, beginMarker: BEGIN_MARKER, endMarker: END_MARKER });
}
```

No caller changes: `agent install` still passes `readBundledSkill()` output, and `init` still calls `agentInstallTarget` per detected runtime. `writeAgentSnippet` continues to wrap the (now frontmatter-free) body in the `<!-- secret-shuttle:begin/end -->` markers, so the snippet never contains a `---` fence.

## Data flow

```
readBundledSkill()                      raw SKILL.md (frontmatter + body)
        |
        v
agentInstallTarget(target, {raw, cwd})
        |
        v
frameSkillForTarget(target, raw)        validate frontmatter → per-target framing
        |                          
   wholesale│snippet
        |        |
        v        v
writeAgentFile   writeAgentSnippet      claude=raw · cursor=.mdc · codex/copilot=body-in-markers
```

## Error handling

- **`skill_frontmatter_invalid`** (new `ShuttleError`): thrown by `frameSkillForTarget` when the bundled SKILL.md lacks frontmatter, has a fence whose inner YAML is **malformed** (parse failure), or whose `name`/`description` is missing, non-string, or blank-after-trim. Fail-closed: nothing is written. In practice this can only fire if the packaged skill is corrupted; the regression test (below) catches it in CI before release.
- **`snippet_ambiguous`** (existing): unchanged — `writeAgentSnippet` still refuses to write when a target has duplicate line-anchored markers.
- The bundled-skill-missing path (`skill_bundled_file_missing`) is unchanged.

## Testing

New unit tests in `src/cli/skill-frame.test.ts` (node:test + node:assert/strict), using a small in-memory fixture string with valid frontmatter plus an assertion against the **real** packaged file:

1. **Canonical file is discoverable** — read the real `skills/secret-shuttle/SKILL.md`, assert `splitFrontmatter` yields non-empty `name` and `description`, and `description` length ≤ 1024.
2. **claude framing** retains skill frontmatter — output starts with `---` and contains `name: secret-shuttle`; body preserved.
3. **cursor framing** emits the exact `.mdc` shape — assert on the **literal emitted text** of the frontmatter block, not just parsed-YAML equivalence: the `description` is on a **single line** (no YAML continuation/wrapped lines even for the ~250-char description), `globs:` is blank (not `globs: ""`), `alwaysApply: false` is present, key order is `description`/`globs`/`alwaysApply`, and there is **no** `name:` key; body preserved after the fence. Include a case with a deliberately long description to prove `lineWidth: 0` prevents wrapping.
4. **codex framing** and **copilot framing** — output has **no** leading `---` fence (body only); body preserved.
5. **Validation fail-closed** — `frameSkillForTarget` throws `skill_frontmatter_invalid` for: input with no frontmatter; frontmatter with a blank/whitespace-only `name` or `description`; frontmatter whose `name` or `description` is a **non-string** value (e.g. a number, list, or mapping); a `description` containing an embedded `\r` or `\n` (multi-line scalar); and a present-but-**malformed-YAML** frontmatter fence.

**Wiring coverage (so the install path can't bypass the framing).** The above prove `skill-frame.ts` in isolation, but a developer could implement it correctly and forget to call it in `agentInstallTarget`, leaving these green. Add tests (in `src/cli/commands/agent.test.ts` — extend if it exists, else create) that exercise `agentInstallTarget` end-to-end against a temp dir and assert the **written file** reflects framing, for at least:
- `cursor` (wholesale) — the written `.cursor/rules/secret-shuttle.mdc` has the `.mdc` frontmatter shape from §3 above (proving the helper was invoked, not a verbatim copy), and
- one **snippet** target (`codex` → `AGENTS.md` or `copilot` → `.github/copilot-instructions.md`) — the written file contains the body wrapped in the `<!-- secret-shuttle:begin/end -->` markers and **no** `---` frontmatter fence inside the markers.

If the `init` path (`installAgentSkills`) is exercisable in the test harness, add a parallel assertion that an init-driven install of the Cursor target produces the same framed `.mdc` output; otherwise note that `init` delegates to the same `agentInstallTarget` and is covered transitively.

These mirror the repo's existing drift-guard discipline (`src/e2e/docs-no-removed-verbs.test.ts`): the canonical-file assertion fails the suite if a future edit strips the frontmatter, so discovery can't silently regress, and the wiring tests fail if the install path stops framing.

The full suite (`npm test`) must stay green.

## Files

- **Modify** `skills/secret-shuttle/SKILL.md` — add frontmatter (`name` + `description`) and the one-line re-read nudge blockquote.
- **Create** `src/cli/skill-frame.ts` — `splitFrontmatter` + `frameSkillForTarget` (pure; depends on `yaml` and `ShuttleError`).
- **Modify** `src/cli/commands/agent.ts` — `agentInstallTarget` frames via `frameSkillForTarget` before writing.
- **Create** `src/cli/skill-frame.test.ts` — unit tests (incl. exact-`.mdc`-text assertions and non-string/malformed-YAML fail-closed cases) + canonical-file discoverability assertion.
- **Create/extend** `src/cli/commands/agent.test.ts` — wiring tests proving `agentInstallTarget` (and thereby `init`) actually frames per target before writing (Cursor `.mdc` shape + one snippet target in markers, no stray fence).

## Open questions

None. Cursor load mode resolved: `alwaysApply: false` (description-triggered).
