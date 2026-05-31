# Secret Shuttle Agent Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canonical `skills/secret-shuttle/SKILL.md` discoverable (YAML `name`/`description` frontmatter + a one-line re-read nudge) and correctly framed per install target via a new pure `src/cli/skill-frame.ts`, wired into the single `agentInstallTarget` path so both `agent install` and `init` inherit it.

**Architecture:** A pure framing module (`skill-frame.ts`) owns `splitFrontmatter` (parse the leading `---…---` block with the `yaml` package) and `frameSkillForTarget` (fail-closed frontmatter validation, then per-target output: claude → raw unchanged; cursor → byte-exact `.mdc` rule; codex/copilot → frontmatter-stripped body). `agentInstallTarget` calls `frameSkillForTarget` before writing. A new `skill_frontmatter_invalid` ShuttleError is registered so corrupt packaged frontmatter fails closed.

**Tech Stack:** TypeScript (ESM, `nodenext`, Node ≥20), commander, **yaml ^2.9.0** (already a dependency), node:test + node:assert/strict.

---

## Scope note: files beyond the spec's Files list

The spec's "Files" section lists SKILL.md, skill-frame.ts, agent.ts, skill-frame.test.ts, agent.test.ts. The spec also introduces a **new** `skill_frontmatter_invalid` ShuttleError and requires that `npm test` stays green. Two existing files therefore must also change, as a direct consequence of those two spec requirements:

- **`src/shared/error-codes.ts`** — register `skill_frontmatter_invalid` (otherwise the thrown error silently defaults to exit code 1 / TRANSIENT, which mis-signals a corrupt-package condition as retry-safe).
- **`src/shared/error-codes.test.ts`** — the registry has a hard-coded count drift-guard (`assert.equal(codes.length, 150)` at the time of writing). Adding one entry makes it 151; the count + rationale comment must update or the suite breaks.

These are not scope creep — they are the minimum needed to honor "introduce `skill_frontmatter_invalid`" + "suite stays green". No other behavior in those files changes.

## File Structure

- **Create `src/cli/skill-frame.ts`** — pure framing module. One responsibility: turn raw bundled SKILL.md text into per-target framed text. Exports `splitFrontmatter(raw)` and `frameSkillForTarget(target, raw)`. Depends on `yaml` (`parse`/`stringify`), `ShuttleError`, and the `AgentTarget` *type* (type-only import from `agent.ts` — erased at runtime, so no circular runtime dependency).
- **Create `src/cli/skill-frame.test.ts`** — unit tests for the module: in-memory fixtures for split/frame/validation/`.mdc`-byte-shape, plus one assertion against the **real** packaged `SKILL.md` (discoverability drift-guard).
- **Modify `src/cli/commands/agent.ts`** — `agentInstallTarget` frames via `frameSkillForTarget` before writing. No other change; no caller change.
- **Modify `src/cli/commands/agent.test.ts`** — update the existing fixture (now needs valid frontmatter) and the per-target assertions, since wiring framing in changes what gets written. Add wiring assertions proving the `.mdc` shape (cursor) and frontmatter-stripped body-in-markers (snippet).
- **Modify `skills/secret-shuttle/SKILL.md`** — prepend `name`/`description` frontmatter; insert the one-line re-read nudge blockquote. No other body change.
- **Modify `src/shared/error-codes.ts`** — register `skill_frontmatter_invalid`.
- **Modify `src/shared/error-codes.test.ts`** — bump registry count 150 → 151 + rationale comment + spot-check.

**Task order rationale:** register the error code first (Task 1) so the module that throws it (Tasks 2–3) lands on a green registry; build the pure module before touching the real SKILL.md (Task 4, whose discoverability test goes red until frontmatter is added) and before wiring (Task 5, which would make `agent install` throw at runtime if the real file still lacked frontmatter — Task 4 precedes it). Each task ends on a green suite.

---

### Task 1: Register `skill_frontmatter_invalid` error code

**Files:**
- Modify: `src/shared/error-codes.ts` (Not-found section, near `skill_bundled_file_missing` at line ~200)
- Modify: `src/shared/error-codes.test.ts:132-203` (count drift-guard) and add a focused spot-check

**Rationale:** `skill_frontmatter_invalid` fires only when the *packaged* SKILL.md is corrupt (missing/malformed/non-string/blank/multiline frontmatter). It is the sibling of `skill_bundled_file_missing` ("the packaged skill is unusable"), so it shares that code's class — `EXIT_CODE_NOT_FOUND` (3), `hint: () => null`, no `nextAction` (recovery is "reinstall", carried in the throw-site message, matching `skill_bundled_file_missing`'s convention).

- [ ] **Step 1: Write the failing spot-check + bump the count**

In `src/shared/error-codes.test.ts`, update the count assertion (line ~177) from `150` to `151` and extend the rationale comment block (just above it, after the `Burst 5 Task 1.1 … = 150 total.` line) with:

```typescript
  // Spec C onboarding adds 1 more (skill_frontmatter_invalid — thrown by
  // frameSkillForTarget when the bundled SKILL.md frontmatter is absent,
  // malformed, non-string, blank, or multi-line) = 151 total.
```

Change the assertion line to:

```typescript
  assert.equal(codes.length, 151, `expected 151 registry entries, got ${codes.length}`);
```

Then add a new focused test at the end of the file (after the `legacy_key_present has nextAction` test, line ~429):

```typescript
test("error-codes: skill_frontmatter_invalid → NOT_FOUND, null hint, no automatic nextAction", () => {
  const entry = lookupErrorCode("skill_frontmatter_invalid");
  assert.ok(entry, "skill_frontmatter_invalid must be registered");
  assert.strictEqual(entry.exitCode, EXIT_CODE_NOT_FOUND);
  assert.strictEqual(entry.hint(""), null);
  const next = entry.nextAction ? entry.nextAction("") : null;
  assert.strictEqual(next, null, "no automatic recovery — reinstall is the manual fix");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/shared/error-codes.test.js"`
Expected: FAIL — both the count test (`expected 151 registry entries, got 150`) and the new spot-check (`skill_frontmatter_invalid must be registered` → entry is null).

- [ ] **Step 3: Register the code**

In `src/shared/error-codes.ts`, in the Not-found section, immediately after the `skill_bundled_file_missing` line (line ~200):

```typescript
  skill_bundled_file_missing: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
  skill_frontmatter_invalid: { exitCode: EXIT_CODE_NOT_FOUND, hint: () => null },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/shared/error-codes.test.js"`
Expected: PASS (all error-codes tests green; count = 151).

- [ ] **Step 5: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(onboarding): register skill_frontmatter_invalid error code"
```

---

### Task 2: `splitFrontmatter` in `skill-frame.ts`

**Files:**
- Create: `src/cli/skill-frame.ts`
- Create: `src/cli/skill-frame.test.ts`

**Behavior:** Detect a leading `---` line + matching closing `---` line. If both present, parse the inner YAML; on parse failure OR a non-object result (string/number/array/null), throw `skill_frontmatter_invalid` (a present-but-broken block is corruption, not "absent"). If there is no leading `---` line at all — or a leading `---` with no closing fence — return `{ data: null, body: raw }` (conventional gray-matter behavior; the install path still fails closed later because `frameSkillForTarget` rejects `data === null`). Body = everything after the closing fence with leading blank lines trimmed.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/skill-frame.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { splitFrontmatter, frameSkillForTarget } from "./skill-frame.js";
import { ShuttleError } from "../shared/errors.js";

const FM = [
  "---",
  "name: secret-shuttle",
  "description: Use secret refs without plaintext",
  "---",
  "",
  "# Body Heading",
  "body line",
  "",
].join("\n");

const BODY = "# Body Heading\nbody line\n";

test("splitFrontmatter parses leading frontmatter and trims body's leading blank lines", () => {
  const { data, body } = splitFrontmatter(FM);
  assert.ok(data);
  assert.equal(data.name, "secret-shuttle");
  assert.equal(data.description, "Use secret refs without plaintext");
  assert.equal(body, BODY);
});

test("splitFrontmatter returns data=null, body=raw when no leading fence", () => {
  const raw = "# Just a body\nno frontmatter\n";
  const { data, body } = splitFrontmatter(raw);
  assert.equal(data, null);
  assert.equal(body, raw);
});

test("splitFrontmatter returns data=null when a leading fence has no closing fence", () => {
  const raw = "---\nname: x\nno closing fence here\n";
  const { data, body } = splitFrontmatter(raw);
  assert.equal(data, null);
  assert.equal(body, raw);
});

test("splitFrontmatter throws skill_frontmatter_invalid on malformed inner YAML", () => {
  // Both fences present, inner YAML is invalid (unclosed flow mapping).
  const raw = "---\nname: {unterminated\n---\n\nbody\n";
  assert.throws(
    () => splitFrontmatter(raw),
    (e: unknown) => e instanceof ShuttleError && e.code === "skill_frontmatter_invalid",
  );
});

test("splitFrontmatter throws skill_frontmatter_invalid when inner YAML is not an object", () => {
  const raw = "---\njust a bare string\n---\n\nbody\n";
  assert.throws(
    () => splitFrontmatter(raw),
    (e: unknown) => e instanceof ShuttleError && e.code === "skill_frontmatter_invalid",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/skill-frame.test.js"`
Expected: FAIL — build error / `Cannot find module './skill-frame.js'` (module does not exist yet).

- [ ] **Step 3: Implement `splitFrontmatter`**

Create `src/cli/skill-frame.ts`:

```typescript
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { ShuttleError } from "../shared/errors.js";
import type { AgentTarget } from "./commands/agent.js";

export interface SplitFrontmatterResult {
  data: Record<string, unknown> | null;
  body: string;
}

const FRONTMATTER_INVALID =
  "The bundled SKILL.md frontmatter is missing or malformed (expected a leading `---` block with non-empty single-line string `name` and `description`). Reinstall secret-shuttle.";

/**
 * Split a SKILL.md string into parsed frontmatter `data` and `body`.
 *
 *  - No leading `---` line, or a leading `---` with no matching closing `---`
 *    line → `{ data: null, body: raw }` (treated as "no frontmatter").
 *  - Both fences present but the inner YAML fails to parse OR does not parse
 *    to a plain object → throws ShuttleError("skill_frontmatter_invalid").
 *    A present-but-broken block is a corruption signal, not "absent".
 *  - Otherwise → `{ data, body }`, where body is everything after the closing
 *    fence with leading blank lines trimmed.
 */
export function splitFrontmatter(raw: string): SplitFrontmatterResult {
  const lines = raw.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return { data: null, body: raw };
  }
  // Find the closing fence: the next line (index >= 1) that is exactly `---`.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Opening fence with no close — treat as no frontmatter (least surprising).
    return { data: null, body: raw };
  }
  const inner = lines.slice(1, closeIdx).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(inner);
  } catch {
    throw new ShuttleError("skill_frontmatter_invalid", FRONTMATTER_INVALID);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ShuttleError("skill_frontmatter_invalid", FRONTMATTER_INVALID);
  }
  // Body = lines after the closing fence, with leading blank lines trimmed.
  let bodyStart = closeIdx + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
    bodyStart++;
  }
  const body = lines.slice(bodyStart).join("\n");
  return { data: parsed as Record<string, unknown>, body };
}
```

(Note: `yamlStringify` and `AgentTarget` are imported now but used in Task 3 — `frameSkillForTarget` is added there. If the implementer prefers a green build between steps, they may add a minimal `frameSkillForTarget` stub here, but it is cleaner to land Task 2 with the import and add the function body in Task 3. The test file already imports `frameSkillForTarget`, so define it in Task 3.)

To keep this task self-contained and the build green, also add the `frameSkillForTarget` skeleton at the bottom of `skill-frame.ts` now (full body in Task 3):

```typescript
export function frameSkillForTarget(target: AgentTarget, raw: string): string {
  // Implemented in Task 3.
  void yamlStringify;
  void target;
  void raw;
  throw new ShuttleError("skill_frontmatter_invalid", FRONTMATTER_INVALID);
}
```

- [ ] **Step 4: Run the tests to verify split tests pass**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/skill-frame.test.js"`
Expected: the five `splitFrontmatter …` tests PASS. (Any `frameSkillForTarget`/canonical tests are not added until Tasks 3–4.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/skill-frame.ts src/cli/skill-frame.test.ts
git commit -m "feat(onboarding): add splitFrontmatter to skill-frame module"
```

---

### Task 3: `frameSkillForTarget` — validation + per-target framing

**Files:**
- Modify: `src/cli/skill-frame.ts` (replace the `frameSkillForTarget` skeleton)
- Modify: `src/cli/skill-frame.test.ts` (add framing + validation + `.mdc`-byte-shape tests)

**Behavior:** Validate via `splitFrontmatter`, then fail-closed unless ALL hold: `data` non-null object; `data.name` is a string non-empty after trim; `data.description` is a string non-empty after trim; the trimmed `description` has no `\r`/`\n`. Use the **trimmed** `description` downstream. Then branch: `claude` → raw unchanged; `cursor` → byte-exact `.mdc` (description / blank `globs:` / `alwaysApply: false`, key order fixed, single-line description via `lineWidth: 0`); `codex`/`copilot` → body only.

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/skill-frame.test.ts`:

```typescript
const EXPECTED_MDC_FRONTMATTER = [
  "---",
  "description: Use secret refs without plaintext",
  "globs:",
  "alwaysApply: false",
  "---",
  "",
  "",
].join("\n");

test("frameSkillForTarget('claude') returns the raw content unchanged", () => {
  assert.equal(frameSkillForTarget("claude", FM), FM);
});

test("frameSkillForTarget('cursor') emits the exact .mdc byte shape", () => {
  const out = frameSkillForTarget("cursor", FM);
  // Literal byte-shape contract: frontmatter block then a blank line then body.
  assert.equal(out, EXPECTED_MDC_FRONTMATTER + BODY);
  // Spot assertions reinforcing the contract.
  assert.ok(out.startsWith("---\ndescription: "));
  assert.ok(out.includes("\nglobs:\n"));            // blank globs, not `globs: ""`
  assert.ok(out.includes("\nalwaysApply: false\n"));
  assert.ok(!out.includes("name:"));                 // skill frontmatter dropped
});

test("frameSkillForTarget('cursor') keeps a long description on a single line (lineWidth:0)", () => {
  const longDesc = "x".repeat(250);
  const raw = `---\nname: secret-shuttle\ndescription: ${longDesc}\n---\n\n${BODY}`;
  const out = frameSkillForTarget("cursor", raw);
  const lines = out.split("\n");
  const descLineIdx = lines.findIndex((l) => l.startsWith("description: "));
  assert.ok(descLineIdx >= 0, "description line present");
  // The whole 250-char description is on one line (no YAML continuation/wrap).
  assert.equal(lines[descLineIdx], `description: ${longDesc}`);
  // The very next line is `globs:` — proves the description did not wrap.
  assert.equal(lines[descLineIdx + 1], "globs:");
});

test("frameSkillForTarget('codex') returns body only (no leading fence)", () => {
  const out = frameSkillForTarget("codex", FM);
  assert.equal(out, BODY);
  assert.ok(!out.startsWith("---"));
  assert.ok(!out.includes("name:"));
});

test("frameSkillForTarget('copilot') returns body only (no leading fence)", () => {
  const out = frameSkillForTarget("copilot", FM);
  assert.equal(out, BODY);
  assert.ok(!out.startsWith("---"));
});

// ── Validation: fail-closed ────────────────────────────────────────────────
function assertInvalid(raw: string, msg: string): void {
  assert.throws(
    () => frameSkillForTarget("claude", raw),
    (e: unknown) => e instanceof ShuttleError && e.code === "skill_frontmatter_invalid",
    msg,
  );
}

test("frameSkillForTarget throws when frontmatter is absent", () => {
  assertInvalid("# No frontmatter\nbody\n", "absent frontmatter must fail closed");
});

test("frameSkillForTarget throws when name is blank/whitespace", () => {
  assertInvalid("---\nname: '   '\ndescription: ok desc\n---\n\nbody\n", "blank name");
});

test("frameSkillForTarget throws when description is blank/whitespace", () => {
  assertInvalid("---\nname: secret-shuttle\ndescription: '   '\n---\n\nbody\n", "blank description");
});

test("frameSkillForTarget throws when name is a non-string value", () => {
  assertInvalid("---\nname: 42\ndescription: ok desc\n---\n\nbody\n", "numeric name");
});

test("frameSkillForTarget throws when description is a non-string value (list)", () => {
  assertInvalid("---\nname: secret-shuttle\ndescription:\n  - a\n  - b\n---\n\nbody\n", "list description");
});

test("frameSkillForTarget throws when description contains an embedded newline", () => {
  // A YAML block scalar produces a multi-line string value.
  const raw = "---\nname: secret-shuttle\ndescription: |\n  line one\n  line two\n---\n\nbody\n";
  assertInvalid(raw, "multi-line description must fail closed");
});

test("frameSkillForTarget throws on present-but-malformed YAML frontmatter", () => {
  assertInvalid("---\nname: {unterminated\n---\n\nbody\n", "malformed YAML fence");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/skill-frame.test.js"`
Expected: FAIL — the `claude`/`cursor`/`codex`/`copilot` framing tests fail (skeleton always throws), and the validation tests that expect a throw will *pass by accident* against the skeleton — that's fine; the framing tests are the genuine red.

- [ ] **Step 3: Implement `frameSkillForTarget`**

Replace the `frameSkillForTarget` skeleton in `src/cli/skill-frame.ts` with:

```typescript
/**
 * Build the Cursor `.mdc` frontmatter + body. The `.mdc` is a compatibility
 * surface that must match Cursor's documented rule shape, so the byte layout
 * (single-line description, blank `globs:`, `alwaysApply: false`, fixed key
 * order) is the contract — see src/cli/skill-frame.test.ts.
 */
function buildCursorMdc(description: string, body: string): string {
  // yamlStringify gives correct quoting/escaping for the description string;
  // lineWidth: 0 disables column wrapping so it stays on a single line.
  const descLine = yamlStringify({ description }, { lineWidth: 0 }).trimEnd();
  const frontmatter = `---\n${descLine}\nglobs:\nalwaysApply: false\n---\n`;
  return `${frontmatter}\n${body}`;
}

export function frameSkillForTarget(target: AgentTarget, raw: string): string {
  const { data, body } = splitFrontmatter(raw);
  if (
    data === null ||
    typeof data.name !== "string" ||
    data.name.trim() === "" ||
    typeof data.description !== "string" ||
    data.description.trim() === "" ||
    /[\r\n]/.test(data.description.trim())
  ) {
    throw new ShuttleError("skill_frontmatter_invalid", FRONTMATTER_INVALID);
  }
  const description = (data.description as string).trim();
  switch (target) {
    case "claude":
      return raw;
    case "cursor":
      return buildCursorMdc(description, body);
    case "codex":
    case "copilot":
      return body;
    default: {
      const _exhaustive: never = target;
      throw new ShuttleError("bad_request", `unknown agent target: ${String(_exhaustive)}`);
    }
  }
}
```

Also delete the now-unused `void yamlStringify; void target; void raw;` skeleton lines (they were replaced wholesale by the block above).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/skill-frame.test.js"`
Expected: PASS — all `splitFrontmatter`, `frameSkillForTarget`, `.mdc`-shape, and validation tests green.

> If the literal-equality `.mdc` test fails because `yaml` quotes the simple description, the emitted text *is* the contract: update `EXPECTED_MDC_FRONTMATTER`'s description line to match the actual single-line output, then re-run. The fixture description ("Use secret refs without plaintext") is deliberately plain (no `:`/`#`/leading `-`) and should serialize unquoted.

- [ ] **Step 5: Commit**

```bash
git add src/cli/skill-frame.ts src/cli/skill-frame.test.ts
git commit -m "feat(onboarding): add frameSkillForTarget with fail-closed validation + Cursor .mdc shape"
```

---

### Task 4: SKILL.md frontmatter + re-read nudge

**Files:**
- Modify: `skills/secret-shuttle/SKILL.md:1-6`
- Modify: `src/cli/skill-frame.test.ts` (add the canonical-file discoverability test)

**Behavior:** Add `name`/`description` frontmatter so Claude Code can auto-load the skill, and insert the one-line re-read nudge. The new discoverability test reads the **real** packaged file through `splitFrontmatter` and fails the suite if a future edit strips the frontmatter.

- [ ] **Step 1: Write the failing test**

Append to `src/cli/skill-frame.test.ts`:

```typescript
test("canonical SKILL.md is discoverable: non-empty name + description, description <= 1024", async () => {
  const skillPath = join(process.cwd(), "skills/secret-shuttle/SKILL.md");
  const raw = await readFile(skillPath, "utf8");
  const { data } = splitFrontmatter(raw);
  assert.ok(data, "canonical SKILL.md must have frontmatter");
  assert.equal(typeof data.name, "string");
  assert.ok((data.name as string).trim().length > 0, "name must be non-empty");
  assert.equal(typeof data.description, "string");
  const description = (data.description as string).trim();
  assert.ok(description.length > 0, "description must be non-empty");
  assert.ok(description.length <= 1024, `description must be <= 1024 chars (got ${description.length})`);
  // Single-line: no embedded newline (the .mdc single-line contract relies on this).
  assert.ok(!/[\r\n]/.test(description), "description must be single-line");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/skill-frame.test.js"`
Expected: FAIL — `canonical SKILL.md must have frontmatter` (the real file currently opens with `# Secret Shuttle`, so `splitFrontmatter` returns `data: null`).

- [ ] **Step 3: Add frontmatter + nudge to the real SKILL.md**

In `skills/secret-shuttle/SKILL.md`, replace the opening block (current lines 1-6):

old:
```markdown
# Secret Shuttle

Local-daemon CLI that lets AI coding agents provision and use secrets without ever seeing them.
You work with refs (`ss://stripe/prod/STRIPE_WEBHOOK_SECRET`); the daemon resolves them at the last possible moment.

## 30-second quickstart
```

new:
```markdown
---
name: secret-shuttle
description: Use when an AI coding agent must provision, inject, run, or rotate secrets without ever seeing their plaintext — you work with ss:// refs (like ss://stripe/prod/STRIPE_WEBHOOK_SECRET) while a local daemon resolves the real value at the last possible moment.
---

# Secret Shuttle

Local-daemon CLI that lets AI coding agents provision and use secrets without ever seeing them.
You work with refs (`ss://stripe/prod/STRIPE_WEBHOOK_SECRET`); the daemon resolves them at the last possible moment.

> Skills evolve. Treat this on-disk file — and live `status --json` / a command's `next_action` — as the source of truth over anything you remember from an earlier read.

## 30-second quickstart
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/skill-frame.test.js" "dist/cli/commands/skill-md-shape.test.js"`
Expected: PASS — the canonical discoverability test is green, and the existing `skill-md-shape.test.ts` stays green (its `findIndex(l.trim()==='---' && i>0)` now locks onto the closing frontmatter fence at line index 3, which is `> 0 && <= 65`).

- [ ] **Step 5: Commit**

```bash
git add skills/secret-shuttle/SKILL.md src/cli/skill-frame.test.ts
git commit -m "feat(onboarding): add discovery frontmatter + re-read nudge to SKILL.md"
```

---

### Task 5: Wire framing into `agentInstallTarget` + update wiring tests

**Files:**
- Modify: `src/cli/commands/agent.ts:1-10` (import) and `agent.ts:73-89` (`agentInstallTarget`)
- Modify: `src/cli/commands/agent.test.ts` (fixture + per-target assertions)

**Behavior:** `agentInstallTarget` runs `frameSkillForTarget(target, opts.skillContent)` before writing. The existing `agent.test.ts` fixture (`"# Fake Skill\nbody\n"`, no frontmatter) would now make `agentInstallTarget` throw, so the fixture gains valid frontmatter and the per-target assertions are updated to reflect framing (cursor → `.mdc` shape; codex/copilot → frontmatter-stripped body in markers).

- [ ] **Step 1: Update the tests (they will fail against the un-wired code)**

In `src/cli/commands/agent.test.ts`, replace the fixture constant (line ~18):

old:
```typescript
const FAKE_SKILL_CONTENT = "# Fake Skill\nbody\n";
```

new:
```typescript
const FAKE_BODY = "# Fake Skill\nbody\n";
const FAKE_SKILL_CONTENT = [
  "---",
  "name: secret-shuttle",
  "description: Use secret refs without plaintext",
  "---",
  "",
  FAKE_BODY,
].join("\n");
```

Replace the `cursor` wholesale test (lines ~29-36):

old:
```typescript
test("agentInstallTarget('cursor') writes wholesale to .cursor/rules/secret-shuttle.mdc", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("cursor", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".cursor/rules/secret-shuttle.mdc"), "utf8");
    assert.equal(out, FAKE_SKILL_CONTENT);
  } finally { restore(); }
});
```

new:
```typescript
test("agentInstallTarget('cursor') writes a framed .mdc rule (description/globs/alwaysApply, no skill frontmatter)", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("cursor", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".cursor/rules/secret-shuttle.mdc"), "utf8");
    assert.ok(out.startsWith("---\ndescription: "), "starts with .mdc frontmatter");
    assert.ok(out.includes("\nglobs:\n"), "blank globs line");
    assert.ok(out.includes("\nalwaysApply: false\n"), "alwaysApply: false");
    assert.ok(!out.includes("name: secret-shuttle"), "skill frontmatter stripped");
    assert.ok(out.includes(FAKE_BODY), "body preserved");
  } finally { restore(); }
});
```

Replace the `codex` snippet test (lines ~38-47):

old:
```typescript
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
```

new:
```typescript
test("agentInstallTarget('codex') writes a frontmatter-stripped body in markers to AGENTS.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.ok(out.startsWith(BEGIN));
    assert.ok(out.includes(FAKE_BODY), "body preserved");
    // No skill frontmatter (and therefore no `---` fence) inside the snippet.
    const between = out.slice(out.indexOf(BEGIN) + BEGIN.length, out.indexOf(END));
    assert.ok(!between.includes("name: secret-shuttle"), "frontmatter stripped");
    assert.ok(!between.trimStart().startsWith("---"), "no leading frontmatter fence in snippet");
    assert.ok(out.endsWith(`${END}\n`));
  } finally { restore(); }
});
```

Replace the `copilot` snippet test (lines ~49-57):

old:
```typescript
test("agentInstallTarget('copilot') writes a marked snippet to .github/copilot-instructions.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("copilot", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
    assert.ok(out.includes(BEGIN));
    assert.ok(out.includes(FAKE_SKILL_CONTENT));
  } finally { restore(); }
});
```

new:
```typescript
test("agentInstallTarget('copilot') writes a frontmatter-stripped body in markers to .github/copilot-instructions.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("copilot", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
    assert.ok(out.includes(BEGIN));
    assert.ok(out.includes(FAKE_BODY), "body preserved");
    assert.ok(!out.includes("name: secret-shuttle"), "frontmatter stripped");
  } finally { restore(); }
});
```

The remaining `agentInstallTarget('claude')` tests (wholesale write at lines ~20-27 and wholesale-overwrite at ~83-94) keep their `assert.equal(out, FAKE_SKILL_CONTENT)` assertions — `claude` framing returns the raw content unchanged, so they pass with the new (frontmatter-bearing) fixture. The idempotency (lines ~59-70) and preserves-preexisting (lines ~72-81) tests only check marker counts / unrelated content and need no change.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/commands/agent.test.js"`
Expected: FAIL — `cursor`/`codex`/`copilot` tests fail because the un-wired `agentInstallTarget` still writes `opts.skillContent` verbatim (cursor file equals the raw frontmatter+body, not the `.mdc` shape; snippets still contain `name: secret-shuttle`).

- [ ] **Step 3: Wire `frameSkillForTarget` into `agentInstallTarget`**

In `src/cli/commands/agent.ts`, add the import after the existing `writeAgentFile`/`writeAgentSnippet` import (line 6):

```typescript
import { writeAgentFile, writeAgentSnippet } from "../agent-writer.js";
import { frameSkillForTarget } from "../skill-frame.js";
```

Then update `agentInstallTarget` (lines 73-89):

old:
```typescript
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
```

new:
```typescript
export async function agentInstallTarget(
  target: AgentTarget,
  opts: { skillContent: string; cwd: string },
): Promise<void> {
  const spec = TARGETS[target];
  const dest = path.resolve(opts.cwd, spec.destPath);
  const framed = frameSkillForTarget(target, opts.skillContent);
  if (spec.mode === "wholesale") {
    await writeAgentFile({ targetPath: dest, content: framed });
  } else {
    await writeAgentSnippet({
      targetPath: dest,
      content: framed,
      beginMarker: BEGIN_MARKER,
      endMarker: END_MARKER,
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/commands/agent.test.js"`
Expected: PASS — all `agent.test.ts` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/agent.ts src/cli/commands/agent.test.ts
git commit -m "feat(onboarding): frame skill per target in agentInstallTarget"
```

---

### Task 6: Full suite green + manual install smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — entire suite green (build succeeds; `error-codes`, `skill-frame`, `agent`, `skill-md-shape`, and all others pass).

- [ ] **Step 2: Manual smoke — real bundled skill frames per target**

Run (from the repo root; writes into a throwaway temp dir, never the repo):

```bash
npm run build && \
SMOKE=$(mktemp -d) && \
( cd "$SMOKE" && node "$OLDPWD/dist/cli/index.js" agent install cursor && node "$OLDPWD/dist/cli/index.js" agent install codex ) && \
echo "=== .cursor/rules/secret-shuttle.mdc (head) ===" && head -8 "$SMOKE/.cursor/rules/secret-shuttle.mdc" && \
echo "=== AGENTS.md (head) ===" && head -12 "$SMOKE/AGENTS.md" && \
rm -rf "$SMOKE"
```

Expected:
- `.cursor/rules/secret-shuttle.mdc` starts with `---`, then a single-line `description:` (the real ~250-char description), then `globs:` (blank), then `alwaysApply: false`, then `---`, blank line, then `# Secret Shuttle` — and contains NO `name: secret-shuttle` line.
- `AGENTS.md` starts with `<!-- secret-shuttle:begin -->`, the next non-marker line is `# Secret Shuttle` (NOT a `---` fence and NOT `name:`), and the block ends with `<!-- secret-shuttle:end -->`.

> Verify the CLI entrypoint path: if `dist/cli/index.js` is not the built entry, find it with `node -e "console.log(require('./package.json').bin)"` and substitute. Do not run `agent install` in the repo working tree (it would write `.cursor`/`AGENTS.md` into the repo); always use the temp dir as above.

- [ ] **Step 3: Commit (only if Step 2 surfaced a fix; otherwise nothing to commit)**

If the smoke test revealed a discrepancy, fix the source, re-run `npm test`, and commit with a descriptive message. If everything passed, there is nothing to commit in this task.

---

## Self-Review

**1. Spec coverage:**

- Spec §1 (frontmatter + nudge) → Task 4. ✓
- Spec §2 `splitFrontmatter` (incl. malformed-YAML throws) → Task 2. ✓
- Spec §2 `frameSkillForTarget` validation (null/missing/non-string/blank/`\r\n`) → Task 3 validation tests. ✓
- Spec §2 per-target branching (claude raw / cursor `.mdc` / codex+copilot body) → Task 3. ✓
- Spec §2 Cursor `.mdc` byte shape (lineWidth:0 single-line description, blank `globs:`, `alwaysApply: false`, key order, no `name:`) + literal-text + long-description no-wrap tests → Task 3 (`buildCursorMdc`, `EXPECTED_MDC_FRONTMATTER`, long-desc test). Strategy 1 (manual three-key assembly) chosen per spec §109 preferred. ✓
- Spec §3 wiring into `agentInstallTarget` (single path → both `agent install` and `init`) → Task 5. ✓
- Spec "Error handling" new `skill_frontmatter_invalid` → Task 1 (registration) + Tasks 2-3 (throw sites). ✓
- Spec "Testing" §1 canonical discoverability → Task 4. §2 claude framing → Task 3. §3 cursor exact `.mdc` → Task 3. §4 codex+copilot no fence → Task 3. §5 fail-closed (incl. non-string + malformed-YAML) → Task 3. ✓
- Spec "Testing" wiring coverage (cursor `.mdc` shape + one snippet target body-in-markers no fence; init transitively covered) → Task 5. ✓
- Spec "suite stays green" → Task 6 + the count drift-guard fix in Task 1. ✓

**2. Placeholder scan:** No "TBD"/"implement later". The Task 2 `frameSkillForTarget` skeleton is an explicit, intentional throwing stub that Task 3 replaces wholesale (called out in both tasks); not a placeholder left dangling. Every code step shows complete code.

**3. Type consistency:** `splitFrontmatter` returns `SplitFrontmatterResult { data: Record<string, unknown> | null; body: string }` — used identically in Task 2 (impl), Task 3 (`frameSkillForTarget` destructures `{ data, body }`), and Task 4 (test reads `data.name`/`data.description`). `frameSkillForTarget(target: AgentTarget, raw: string): string` signature is identical across Task 2 skeleton, Task 3 impl, and Task 5 call site. `AgentTarget` is the existing union from `agent.ts` (type-only import in `skill-frame.ts`, avoiding a runtime cycle). `buildCursorMdc(description, body)` is private, defined and used only in Task 3. Fixture/body constant naming: `skill-frame.test.ts` uses `FM`/`BODY`; `agent.test.ts` uses `FAKE_SKILL_CONTENT`/`FAKE_BODY` (distinct files, no collision). Error code string `"skill_frontmatter_invalid"` matches between registry (Task 1), throw sites (Tasks 2-3), and tests.

**4. Build-green-at-each-commit:** Task 1 registry stays green. Task 2 lands `splitFrontmatter` + a throwing `frameSkillForTarget` skeleton (build green; split tests pass). Task 3 fills the skeleton (frame tests pass). Task 4 adds real frontmatter (discoverability test goes red→green; `skill-md-shape` stays green). Task 5 wires + updates `agent.test.ts` (red→green). Task 6 full suite. No commit leaves the suite red.
