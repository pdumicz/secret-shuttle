# Recipe URL Interpolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `browser_inject` recipe URL templatable so the static-URL Vercel recipe (and any future inject recipe) addresses arbitrary user projects via `{name}` placeholders substituted from yml-supplied `url_params`, with a clean fail-closed path when params are missing. Side-effect: remove the `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` allowlist that interpolation makes redundant.

**Architecture:** Tiny pure helper (`recipes/url-template.ts`) substitutes `{name}` tokens from a `Record<string, string>` and throws `recipe_url_params_missing` on any missing/inherited/non-string/empty value. `BootstrapPlanSecret.destinations` changes from `string[]` to `{shorthand, url_params?}[]` so the yml parser normalizes both string-form (back-compat) and object-form entries to a single shape. `computeBootstrapPlan` carries `url_params` through onto the `browser_inject` variant of `ResolvedDestination`. `runBrowserInject` gains a `dest` parameter, calls `interpolateUrl` BEFORE any browser side-effect, and converts the helper's throw into a per-destination `{ok:false, error_code}` so a bad `url_params` on destination N reports as a destination-N failure without aborting destinations N+1…M.

**Tech Stack:** TypeScript (ESM, `"type": "module"`, relative imports with `.js` extension), Node ≥20. Tests: `node:test` + `node:assert/strict`, co-located `*.test.ts`, run against compiled `dist/`. Errors via `ShuttleError` (asserted by `.code`). No lint, no pre-commit hooks.

**Source of truth:** [`docs/superpowers/specs/2026-06-02-recipe-url-interpolation-design.md`](../specs/2026-06-02-recipe-url-interpolation-design.md). Section references below (§1–§10) point at that spec.

---

## How to run tests (every task uses this)

The repo compiles to `dist/` and runs the compiled tests:

```bash
# whole suite
npm test
# single file (faster inner loop) — build first, then run that one compiled file
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/<path-without-src>/<file>.test.js"
# single test by name
npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test --test-name-pattern "<name>" "dist/<...>.test.js"
```

`src/daemon/recipes/url-template.test.ts` compiles to `dist/daemon/recipes/url-template.test.js`. `SECRET_SHUTTLE_NO_OPEN_URL=1` keeps the daemon from opening browser tabs during tests. **Every "run the test" step below means: `npm run build` then `node --test` the compiled file.** If `npm run build` fails to compile, that is a real failure — fix the types before running.

---

## File structure (what each new/changed file is responsible for)

**New:**
- `src/daemon/recipes/url-template.ts` — pure `interpolateUrl(template, params)` helper. Substitutes `{name}` placeholders, throws `recipe_url_params_missing` on missing/inherited/non-string/empty (§5).
- `src/daemon/recipes/url-template.test.ts` — happy path + missing/inherited/non-string/empty rejection + encodeURIComponent + repeated-placeholder + no-placeholder-passthrough.

**Changed:**
- `src/shared/error-codes.ts` — add `recipe_url_params_missing` to the REGISTRY (§8).
- `src/cli/bootstrap/yml.ts` — `BootstrapPlanSecret.destinations` type changes from `string[]` to `{ shorthand: string; url_params?: Record<string, string> }[]`; `parseDestinations` accepts string OR object entries, normalizes to objects, rejects malformed object shapes with `bootstrap_plan_invalid` (§3 + the §3 "Parser-side schema validation for `url_params`" paragraph).
- `src/cli/bootstrap/yml.test.ts` — back-compat string-form keeps passing; new object-form tests + the parser-rejection tests (§9 yml.test.ts cases).
- `src/daemon/bootstrap/plan.ts` — `PlanSelection.coversDestination?` removed; the 3-condition gate collapses to 2 conditions (recipe exists AND CLI absent); `url_params` from the parsed yml destination flows through onto the `browser_inject` variant.
- `src/daemon/bootstrap/plan.test.ts` — the host-only-insufficient §200 test is removed; the remaining selection tests drop the `coversDestination` selection arg; new tests cover the url_params flow-through.
- `src/daemon/api/routes/bootstrap.ts` — the `coveredScopes` Set, the `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` env read, the `coversDestination` predicate, and the `destinationCovered` export all go.
- `src/daemon/api/routes/bootstrap.test.ts` — the 3 `destinationCovered` unit tests are removed.
- `src/daemon/bootstrap/recipe-inject.ts` — signature changes from `runBrowserInject(recipe, ref, deps)` to `runBrowserInject(recipe, dest, ref, deps)`; calls `interpolateUrl(recipe.url, dest.url_params ?? {})` BEFORE any side-effect; converts the `recipe_url_params_missing` throw into a structured `{ok:false, error_code, message}` so the destination loop continues.
- `src/daemon/bootstrap/recipe-inject.test.ts` — existing tests pass through the new signature; add (a) success case with `url_params` substitution asserting the `open` call sees the interpolated URL, (b) missing-param fail-closed case asserting the events array has none of `blind.start` / `open` / etc.
- `src/daemon/bootstrap/executor.ts` — call site at ~line 780 updates to the new 4-arg signature: `await runBrowserInject(recipe, dest, ref, deps)`.
- `src/daemon/recipes/builtin/vercel-inject.ts` — `url` field flips from `TEAM_PLACEHOLDER/PROJECT_PLACEHOLDER` to `{team}/{project}` (§6); doc-comment rewritten.
- `README.md` — provider matrix Vercel row reframed per §10; every `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` mention removed.
- `CHANGELOG.md` — `## Unreleased` entry describing the change, the §200 cleanup, AND the documented behavior change for string-form + no-CLI users (§9 "Documented behavior change").

**Deferred-cleanup note (do NOT fix here).** `src/cli/bootstrap/destination-shorthand.ts` exports a LOCAL `ResolvedDestination` interface that is structurally different from `src/daemon/bootstrap/store.ts`'s `ResolvedDestination` discriminated union. Spec §4 flags it; this plan does not rename either to keep the diff focused. If a task touches that file, leave the local interface alone.

---

## Task 1: Add the `recipe_url_params_missing` error code

**Files:**
- Modify: `src/shared/error-codes.ts` (the `REGISTRY`)
- Modify: `src/shared/error-codes.test.ts` (add an assertion the new code is registered)

- [ ] **Step 1: Write the failing test**

Find the existing recipe-code registration test (`recipe error codes are registered` from Burst 8 Task 1). Either extend that test's list, or add a one-line case asserting the new code is registered. Pattern from that file (look it up first — match the actual `lookupErrorCode` predicate it uses):

```ts
// addendum to src/shared/error-codes.test.ts
test("recipe_url_params_missing is registered", () => {
  assert.ok(lookupErrorCode("recipe_url_params_missing") !== null,
    "recipe_url_params_missing missing from REGISTRY");
});
```

Also bump the existing entry-count sanity check (Burst 8 Task 1 set it to 158 after adding 7 codes — this adds 1 more → 159; verify by reading the current value before changing).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/shared/error-codes.test.js"`
Expected: FAIL (code not present) OR the sanity-check count assertion fails.

- [ ] **Step 3: Add the code**

In `src/shared/error-codes.ts` REGISTRY, add the entry following the existing pattern (`bootstrap_plan_invalid` / `bootstrap_capture_url_invalid` are the closest neighbors for category: USAGE):

```ts
recipe_url_params_missing: {
  exitCode: EXIT_CODE_USAGE,
  hint: () => "Add the missing url_params to the destination in your yml.",
},
```

(Exit-code constant name may be slightly different — check the file's existing constants like `EXIT_CODE_USAGE`/`EXIT_CODE_CONFLICT` and use the USAGE one.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/shared/error-codes.test.js"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/error-codes.ts src/shared/error-codes.test.ts
git commit -m "feat(errors): add recipe_url_params_missing error code"
```

---

## Task 2: Create the `interpolateUrl` helper

**Files:**
- Create: `src/daemon/recipes/url-template.ts`
- Test: `src/daemon/recipes/url-template.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/daemon/recipes/url-template.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolateUrl } from "./url-template.js";
import { isShuttleError } from "../../shared/errors.js";

test("happy path: single placeholder substitutes", () => {
  assert.equal(
    interpolateUrl("https://x.com/{team}/y", { team: "acme" }),
    "https://x.com/acme/y",
  );
});

test("happy path: multiple distinct placeholders substitute", () => {
  assert.equal(
    interpolateUrl("https://x.com/{team}/{project}/y", { team: "acme", project: "app" }),
    "https://x.com/acme/app/y",
  );
});

test("happy path: repeated placeholder substitutes at every occurrence", () => {
  assert.equal(
    interpolateUrl("/{team}/{team}", { team: "acme" }),
    "/acme/acme",
  );
});

test("happy path: no placeholders → template returned unchanged", () => {
  assert.equal(
    interpolateUrl("https://x.com/static", {}),
    "https://x.com/static",
  );
});

test("encodeURIComponent applied to values (space + slash + ?)", () => {
  // Values that would change URL structure without escaping are percent-encoded.
  assert.equal(
    interpolateUrl("/{v}", { v: "a b/c?d" }),
    "/a%20b%2Fc%3Fd",
  );
});

test("missing key → recipe_url_params_missing with the key name in the message", () => {
  assert.throws(
    () => interpolateUrl("/{team}/{project}", { team: "acme" }),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_url_params_missing" && /project/.test(e.message),
  );
});

test("multiple missing keys → all named in the message (unique, no duplicates)", () => {
  assert.throws(
    () => interpolateUrl("/{a}/{b}/{a}", {}),
    (e: unknown) => {
      if (!isShuttleError(e) || e.code !== "recipe_url_params_missing") return false;
      // both names appear; 'a' is listed once (Set-deduped) despite occurring twice in the template
      return /a/.test(e.message) && /b/.test(e.message);
    },
  );
});

test("inherited property is treated as missing (no prototype pollution) — string-valued proto", () => {
  // CRITICAL: this test must use a STRING-valued inherited property. Using
  // `{toString}` on `{}` would pass even for a broken implementation that
  // checked only `typeof v === "string"` (Object.prototype.toString is a
  // function, so the typeof guard already rejects it). To actually prove the
  // `Object.prototype.hasOwnProperty` guard is in place, the inherited value
  // must itself be a string — then ONLY hasOwnProperty discriminates.
  const proto = { team: "INHERITED_ACME" };
  const params = Object.create(proto) as Record<string, string>;
  assert.throws(
    () => interpolateUrl("/{team}", params),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_url_params_missing" && /team/.test(e.message),
  );
});

test("inherited property is treated as missing (no prototype pollution) — toString function", () => {
  // Defense-in-depth: {toString} on {} must also throw. (The string-valued
  // proto test above is the one that actually proves hasOwnProperty is used;
  // this one is kept because the spec calls out `toString`/`constructor` by
  // name as the motivating attack surface.)
  assert.throws(
    () => interpolateUrl("/{toString}", {}),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_url_params_missing",
  );
});

test("non-string value is treated as missing", () => {
  // The yml parser already rejects non-strings; this is the helper's belt-and-suspenders guard.
  // Cast through unknown to bypass TS — the runtime guard is what's under test.
  assert.throws(
    () => interpolateUrl("/{n}", { n: 42 as unknown as string }),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_url_params_missing",
  );
});

test("empty-string value is treated as missing (blocks malformed-URL hazard)", () => {
  // An empty team would produce https://x.com//project/... — a malformed path segment.
  assert.throws(
    () => interpolateUrl("/{team}/{project}", { team: "", project: "app" }),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_url_params_missing" && /team/.test(e.message),
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/url-template.test.js"`
Expected: FAIL (`Cannot find module './url-template.js'`).

- [ ] **Step 3: Implement the helper**

```ts
// src/daemon/recipes/url-template.ts
import { ShuttleError } from "../../shared/errors.js";

/**
 * Substitute `{name}` placeholders in `template` from `params`. Throws
 * `recipe_url_params_missing` if any placeholder has no own-property string
 * value in `params` (missing keys, inherited properties, non-strings, and
 * empty strings all count as "missing" — see below).
 *
 * Placeholder grammar: `\{([a-zA-Z_][a-zA-Z0-9_]*)\}` — alphanumeric +
 * underscore, must start with letter or underscore. Same identifier shape as a
 * JavaScript variable, so authors can pick names without worrying about regex
 * escapes or URL-encoding edge cases.
 *
 * Validation rule: a placeholder counts as supplied only if `params` has its
 * OWN property (`Object.prototype.hasOwnProperty`) and the value's `typeof`
 * is `"string"` AND the string is non-empty. This blocks accidental matches
 * against inherited members like `toString`/`constructor`, non-string values
 * the parser shouldn't have let through but we don't trust, and empty strings
 * (which would produce a malformed URL path segment like `https://vercel.com//my-app/...`).
 *
 * Extra keys in `params` that don't appear in `template` are silently ignored
 * (forward-compat: a recipe author can add a new placeholder later without
 * breaking users who pre-supplied an unused key).
 *
 * Repeated occurrences of the same placeholder all substitute. No nesting,
 * no defaults, no escapes — keep it dumb until a real need emerges.
 */
export function interpolateUrl(template: string, params: Record<string, string>): string {
  const placeholderRe = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  const missing: string[] = [];
  const out = template.replace(placeholderRe, (_, name: string) => {
    const hasOwn = Object.prototype.hasOwnProperty.call(params, name);
    const v = hasOwn ? (params as Record<string, unknown>)[name] : undefined;
    if (!hasOwn || typeof v !== "string" || v === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(v);
  });
  if (missing.length > 0) {
    const uniq = Array.from(new Set(missing));
    throw new ShuttleError(
      "recipe_url_params_missing",
      `Recipe URL needs url_params: ${uniq.join(", ")}. Add \`url_params: { ${uniq.join(": ..., ")}: ... }\` to the destination in your yml.`,
    );
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/url-template.test.js"`
Expected: PASS (11 tests — happy-path × 4, encodeURIComponent, missing × 2, inherited × 2 (string-valued proto + toString), non-string, empty).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/recipes/url-template.ts src/daemon/recipes/url-template.test.ts
git commit -m "feat(recipes): interpolateUrl helper (single-pass {name} substitution, fail-closed)"
```

---

## Task 3: yml parser accepts string OR object destination form

**Files:**
- Modify: `src/cli/bootstrap/yml.ts` (`BootstrapPlanSecret.destinations` type + `parseDestinations`)
- Modify: `src/cli/bootstrap/yml.test.ts` (add object-form + rejection tests)

- [ ] **Step 1: Write the failing tests**

Add these tests to `src/cli/bootstrap/yml.test.ts` (use the existing imports + `parseBootstrapYml` helper + the existing `isShuttleError` / error-code assertion pattern from other tests in the file):

```ts
test("destination string form back-compat: parses to { shorthand } with url_params omitted", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - vercel:production
`;
  const parsed = parseBootstrapYml(yml);
  const dest = parsed.secrets[0].destinations[0];
  assert.equal(dest.shorthand, "vercel:production");
  assert.equal("url_params" in dest, false, "url_params must be OMITTED (not {}) for string form");
});

test("destination object form: parses with url_params", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:preview
        url_params: { team: acme, project: my-app }
`;
  const parsed = parseBootstrapYml(yml);
  const dest = parsed.secrets[0].destinations[0];
  assert.equal(dest.shorthand, "vercel:preview");
  assert.deepEqual(dest.url_params, { team: "acme", project: "my-app" });
});

test("destination object without url_params: same shape as string form (url_params absent)", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
`;
  const parsed = parseBootstrapYml(yml);
  const dest = parsed.secrets[0].destinations[0];
  assert.equal(dest.shorthand, "vercel:production");
  assert.equal("url_params" in dest, false);
});

test("destination object with unknown extra key → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        bogus: yes
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object missing shorthand → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - url_params: { team: acme }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as non-string (number) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: 42
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as empty string → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: ""
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// Shorthand member: full non-string rejection matrix (spec §9 calls these out by name).
test("destination object shorthand as boolean → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: true
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as null → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: null
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as list → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: [vercel, production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination object shorthand as mapping → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: { provider: vercel, env: production }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// Shorthand member: full non-string rejection matrix when the destination entry is
// itself a YAML shorthand (the string-form back-compat path). The parser must reject
// list / mapping / number / boolean / null at the entry level too, not just inside
// the object form. (Empty-string string entry is already covered by the
// "string entries must be non-empty" check in parseDestinations.)
test("destination entry as bare number (e.g. `- 42`) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - 42
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination entry as bare boolean (e.g. `- true`) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - true
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination entry as bare null (e.g. `- ~`) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - ~
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("destination entry as bare list → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - [vercel, production]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params as non-mapping (string) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: "not a mapping"
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with non-string value (number) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: 42 }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with non-string value (boolean) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: true }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// url_params top-level: must be a mapping. String is covered above; add number, list.
test("url_params as non-mapping (number) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: 42
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params as non-mapping (list) → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: [team, project]
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

// url_params member: full non-string rejection matrix (spec §9). Number + boolean
// already covered above; add null, nested mapping, list.
test("url_params member with null value → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: null }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with nested mapping value → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: { nested: acme } }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});

test("url_params member with list value → bootstrap_plan_invalid", () => {
  const yml = `
version: 1
secrets:
  X:
    source: { kind: random_32_bytes }
    destinations:
      - shorthand: vercel:production
        url_params: { team: [a, b] }
`;
  assert.throws(
    () => parseBootstrapYml(yml),
    (e: unknown) => isShuttleError(e) && e.code === "bootstrap_plan_invalid",
  );
});
```

(If the test file doesn't already import `isShuttleError`, add `import { isShuttleError } from "../../shared/errors.js";` at the top.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/bootstrap/yml.test.js"`
Expected: FAIL — either compile errors (the new tests reference `dest.url_params` / `dest.shorthand` and `BootstrapPlanSecret.destinations` is still `string[]`), or runtime failures.

- [ ] **Step 3: Change the type + rewrite `parseDestinations`**

In `src/cli/bootstrap/yml.ts`, change `BootstrapPlanSecret.destinations` (currently line ~16):

```ts
export interface BootstrapPlanSecret {
  name: string;
  source: BootstrapSource;
  destinations: { shorthand: string; url_params?: Record<string, string> }[];
}
```

Rewrite `parseDestinations` to accept string OR object entries. The allowed object keys are exactly `{shorthand, url_params}`:

```ts
function parseDestinations(secretName: string, raw: unknown): { shorthand: string; url_params?: Record<string, string> }[] {
  if (!Array.isArray(raw)) {
    fail(`secrets.${secretName}.destinations: must be an array`);
  }
  if (raw.length === 0) {
    fail(`secrets.${secretName}.destinations: must have at least one entry`);
  }
  const out: { shorthand: string; url_params?: Record<string, string> }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const d = raw[i];
    const path = `secrets.${secretName}.destinations[${i}]`;
    if (typeof d === "string") {
      if (d.length === 0) {
        fail(`${path}: string entries must be non-empty`);
      }
      out.push({ shorthand: d });
      continue;
    }
    if (d === null || typeof d !== "object" || Array.isArray(d)) {
      fail(`${path}: must be a string shorthand or a mapping with { shorthand, url_params? }`);
    }
    const obj = d as Record<string, unknown>;
    // Closed-vocabulary: only `shorthand` and `url_params` allowed.
    const allowedKeys = new Set(["shorthand", "url_params"]);
    for (const k of Object.keys(obj)) {
      if (!allowedKeys.has(k)) {
        fail(`${path}: unknown key "${k}" (allowed: shorthand, url_params)`);
      }
    }
    if (typeof obj.shorthand !== "string" || obj.shorthand.length === 0) {
      fail(`${path}.shorthand: must be a non-empty string`);
    }
    if (obj.url_params === undefined) {
      out.push({ shorthand: obj.shorthand });
      continue;
    }
    if (obj.url_params === null || typeof obj.url_params !== "object" || Array.isArray(obj.url_params)) {
      fail(`${path}.url_params: must be a mapping of string → string`);
    }
    const urlParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.url_params as Record<string, unknown>)) {
      if (typeof v !== "string") {
        fail(`${path}.url_params.${k}: value must be a string (got ${typeof v})`);
      }
      urlParams[k] = v;
    }
    out.push({ shorthand: obj.shorthand, url_params: urlParams });
  }
  return out;
}
```

> Note: omit `url_params` from the output object when the user didn't supply it (string form OR object form without the key) — do NOT default to `{}`. The §3 OMITTED rule is asserted by the "url_params absent" tests in Step 1.

- [ ] **Step 4: Run to verify the new tests pass + full yml suite stays green**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/cli/bootstrap/yml.test.js"`
Expected: PASS — the new tests + every existing yml.test.ts test (back-compat string form must keep parsing identically).

- [ ] **Step 5: Fix any downstream typecheck errors**

`BootstrapPlanSecret.destinations` changing from `string[]` to `{shorthand, url_params?}[]` ripples to every site that reads `entry.destinations`. Run `npm run typecheck`. Likely sites the compiler will flag:
- `src/daemon/bootstrap/plan.ts` — `s.destinations.map((shorthand) => ...)` becomes `s.destinations.map((entry) => ...)` where `entry.shorthand` is the string. (Task 4 will rework this further; for Step 5 just make it compile by renaming `shorthand` parameter → `entry` and reading `entry.shorthand`.)
- Any test fixture in other test files that constructs a `BootstrapPlan` literal with `destinations: ["..."]` — change to `destinations: [{ shorthand: "..." }]`.
- `src/cli/provision/*` — any inference path that emits a `BootstrapPlanSecret` literal needs the new shape.

For each site the compiler flags: make the smallest change that compiles (don't restructure logic). Mechanical literal updates only.

- [ ] **Step 6: Run the full suite (regression check)**

Run: `npm test`
Expected: PASS — baseline at start of Burst 9 is 1712 pass / 0 fail / 18 skipped; after Tasks 1+2+3 it should be 1712 + (11 url-template tests + 23 new yml tests + 1 error-code test) ≈ 1747 pass. (Plan-r1 added: 1 url-template hasOwnProperty test + 11 yml rejection-matrix tests covering shorthand boolean/null/list/mapping at both entry and object levels, plus url_params number/list/null/nested-mapping/list. Plan-r2 adds: 2 more shorthand entry-level rejection tests not present in prior count.)

- [ ] **Step 7: Commit**

```bash
git add src/cli/bootstrap/yml.ts src/cli/bootstrap/yml.test.ts <any-other-files-the-typecheck-forced>
git commit -m "feat(yml): destinations accept string OR { shorthand, url_params? } object form"
```

---

## Task 4: §200 cleanup + `url_params` flow-through in `computeBootstrapPlan`

This is one coherent change: drop the `coversDestination` allowlist machinery from both the plan and the route, AND wire `url_params` from the parsed yml destination through onto the `browser_inject` variant. Splitting plan.ts and bootstrap.ts across two commits would leave the build broken between them (PlanSelection field removed in one commit but still passed in the other).

> **Atomicity requirement — Tasks 4, 5, 6 MUST land together as a single deployable unit.** Task 4 removes the `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` allowlist that today blocks the no-CLI Vercel string-form path from selecting `browser_inject` against the static-placeholder URL. The safety argument only holds once Task 5 (interpolation runs BEFORE any side-effect, fail-closed on missing params) AND Task 6 (Vercel URL flips to `{team}/{project}` placeholders) are also in place — otherwise the intermediate state lets a no-CLI Vercel destination select `browser_inject` while the recipe still has the static dogfood URL. The per-task commits in this plan are LOCAL checkpoints only. Do NOT cut a release, push to main, or otherwise deploy after Tasks 4 / 4-5 alone. Either land Tasks 4-6 as a single squashed merge, or hold the branch unmerged until Task 6 commits.

**Files:**
- Modify: `src/daemon/bootstrap/plan.ts`
- Modify: `src/daemon/bootstrap/plan.test.ts`
- Modify: `src/daemon/api/routes/bootstrap.ts`
- Modify: `src/daemon/api/routes/bootstrap.test.ts`

- [ ] **Step 1: Update plan.test.ts — drop §200 tests, add url_params tests**

In `src/daemon/bootstrap/plan.test.ts`:

(a) DELETE the test named something like `"host-only opt-in is INSUFFICIENT — bare host never covers any scope (§200 guard)"` and any other test that exercises `coversDestination`. The whole `destinationCovered` predicate is going away.

(b) For each remaining selection test, remove the `coversDestination: () => true` / `coversDestination: () => false` arg from the `computeBootstrapPlan(..., { ... })` selection object — those tests will still pass with the 2-condition gate as long as the test was structured around "recipe exists AND CLI absent".

(c) Add these new tests:

```ts
test("url_params from object-form yml destination flows onto browser_inject variant", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [{
      name: "APP_SECRET",
      source: { kind: "random_32_bytes" },
      destinations: [{ shorthand: "vercel:production", url_params: { team: "acme", project: "my-app" } }],
    }],
  };
  const plan = computeBootstrapPlan(parsed, vault, ctx, { recipes: reg(), isCliConfigured: () => false });
  assert.equal(plan[0].destinations[0].kind, "browser_inject");
  assert.deepEqual((plan[0].destinations[0] as { url_params?: Record<string, string> }).url_params, { team: "acme", project: "my-app" });
});

test("string-form yml destination → browser_inject variant with url_params field ABSENT (not {}; §3 OMITTED rule)", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [{
      name: "APP_SECRET",
      source: { kind: "random_32_bytes" },
      destinations: [{ shorthand: "vercel:production" }],
    }],
  };
  const plan = computeBootstrapPlan(parsed, vault, ctx, { recipes: reg(), isCliConfigured: () => false });
  const dest = plan[0].destinations[0];
  assert.equal(dest.kind, "browser_inject");
  // Critical: url_params must NOT be a key on the object at all (not {}). Distinguishes
  // "user supplied none" from "user supplied empty record".
  assert.equal("url_params" in dest, false, "url_params must be OMITTED on the persisted variant");
});

test("string-form destination → template variant when CLI configured (unchanged behavior)", () => {
  const parsed: BootstrapPlan = {
    version: 1,
    secrets: [{
      name: "APP_SECRET",
      source: { kind: "random_32_bytes" },
      destinations: [{ shorthand: "vercel:production" }],
    }],
  };
  const plan = computeBootstrapPlan(parsed, vault, ctx, { recipes: reg(), isCliConfigured: () => true });
  assert.equal(plan[0].destinations[0].kind, "template");
});
```

(Reuse the existing `reg() / vault / ctx` test fixtures already in the file.)

- [ ] **Step 2: Run to verify expected failures**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/plan.test.js"`
Expected:
- The new `url_params from object-form` test FAILS (`computeBootstrapPlan` doesn't pass url_params through yet).
- The new `url_params field ABSENT` test FAILS for the same reason (or because the 3-condition gate still requires `coversDestination`).
- The `template variant when CLI configured` test PASSES already (existing behavior).
- The deleted §200 test is gone — no failure.

- [ ] **Step 3: Update `src/daemon/bootstrap/plan.ts`**

Replace the file (or edit in place — same outcome). Key changes:
- Drop `coversDestination?: ...` from `PlanSelection` interface.
- Drop the `coversDestination = selection.coversDestination ?? (() => false)` line.
- Collapse the gate to 2 conditions.
- Pass `entry.url_params` through onto the browser_inject variant, OMITTING the field when undefined.

```ts
import type { BootstrapPlan } from "../../cli/bootstrap/yml.js";
import { resolveDestinationShorthand } from "../../cli/bootstrap/destination-shorthand.js";
import type { PlanEntry, ResolvedDestination, BootstrapSource } from "./store.js";
import { buildSecretRef, canonicalEnvironment } from "../../shared/refs.js";
import { recipeRegistry, type RecipeRegistry } from "../recipes/registry.js";
import { canonicalHost } from "../recipes/host.js";

interface PlanContext {
  source: string;
  environment: string;
  force: boolean;
}

interface VaultLike {
  has(ref: string): boolean;
}

export interface PlanSelection {
  recipes?: RecipeRegistry;
  /** True iff the vendor CLI for this template_id is usable. Default () => true
   *  preserves today's CLI-always behavior (never auto-picks browser_inject). */
  isCliConfigured?: (templateId: string) => boolean;
}

export function computeBootstrapPlan(
  parsed: BootstrapPlan,
  vault: VaultLike,
  ctx: PlanContext,
  selection: PlanSelection = {},
): PlanEntry[] {
  const recipes = selection.recipes ?? recipeRegistry;
  const isCliConfigured = selection.isCliConfigured ?? (() => true);

  const out: PlanEntry[] = [];
  for (const s of parsed.secrets) {
    const ref =
      s.source.kind === "existing"
        ? s.source.ref
        : buildSecretRef(ctx.source, canonicalEnvironment(ctx.environment), s.name);

    if (s.source.kind !== "existing" && !ctx.force && vault.has(ref)) {
      continue;
    }

    const destinations: ResolvedDestination[] = s.destinations.map((entry) => {
      const r = resolveDestinationShorthand(entry.shorthand, s.name);
      const injectRecipe = recipes.getInject(canonicalHost(r.domain));
      if (injectRecipe !== undefined && !isCliConfigured(r.template_id)) {
        return {
          kind: "browser_inject" as const,
          recipe_host: injectRecipe.host,
          shorthand: entry.shorthand,
          domain: r.domain,
          // OMIT url_params when undefined (§3 rule). Spread-on-defined idiom.
          ...(entry.url_params !== undefined ? { url_params: entry.url_params } : {}),
        };
      }
      return {
        kind: "template" as const,
        shorthand: entry.shorthand,
        template_id: r.template_id,
        template_params: r.template_params,
        domain: r.domain,
      };
    });

    out.push({
      secret: s.name,
      ref,
      source: { ...s.source } as BootstrapSource,
      destinations,
      ...(s.source.kind !== "existing" && ctx.force && vault.has(ref) ? { force: true } : {}),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run plan tests to verify they pass**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/plan.test.js"`
Expected: PASS (all 3 new tests + the remaining existing tests).

- [ ] **Step 5: Strip the route wiring in `bootstrap.ts`**

In `src/daemon/api/routes/bootstrap.ts`:
- Remove the `coveredScopes = new Set(...)` block that reads `process.env.SECRET_SHUTTLE_INJECT_RECIPE_SCOPES`.
- Remove the `coversDestination` predicate.
- Remove the `export function destinationCovered(...)` helper.
- Remove `coversDestination` from the object literal passed as the 4th arg to `computeBootstrapPlan(...)`.

Grep first to be sure you catch every site:

```bash
grep -n "coveredScopes\|coversDestination\|destinationCovered\|SECRET_SHUTTLE_INJECT_RECIPE_SCOPES" src/daemon/api/routes/bootstrap.ts
```

Each match goes away. After the edit, `computeBootstrapPlan(...)` is called with just `{ isCliConfigured }` (and `recipes` defaults to the module singleton).

- [ ] **Step 6: Drop the 3 `destinationCovered` tests from `bootstrap.test.ts`**

In `src/daemon/api/routes/bootstrap.test.ts`, find and delete the tests:
- `"scope-specific opt-in covers exactly the named scope"`
- `"host-only opt-in is INSUFFICIENT — bare host never covers any scope (§200 guard)"`
- `"a named scope does NOT leak to a sibling scope on the same host"`

Remove the `import { destinationCovered } from "./bootstrap.js"` line at the top if no other test in the file references it.

- [ ] **Step 7: Run the affected suites + typecheck**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/plan.test.js" "dist/daemon/api/routes/bootstrap.test.js"`
Expected: PASS.

- [ ] **Step 8: Run the full suite (plan-level selection tests only)**

Run: `npm test`
Expected: PASS for plan-level selection tests. Watch for any test elsewhere that asserted "string-form vercel destination on no-CLI host stays on template" — per spec §9 "Documented behavior change", those expectations have shifted. Such a test would now fail with the destination resolving to `browser_inject`. For plan-time-only tests (no actual `runBrowserInject` call), just update the expected `kind` to `"browser_inject"` — do NOT add assertions about the eventual `recipe_url_params_missing` failure yet (Task 5 wires interpolation; Task 6 flips the Vercel URL to a templated form where the error becomes possible). Executor/e2e tests that exercise the full stack will update when Task 5 lands interpolation and Task 6 lands the placeholder URL.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/bootstrap/plan.ts src/daemon/bootstrap/plan.test.ts src/daemon/api/routes/bootstrap.ts src/daemon/api/routes/bootstrap.test.ts
git commit -m "refactor(bootstrap): drop SECRET_SHUTTLE_INJECT_RECIPE_SCOPES allowlist + flow url_params through plan"
```

---

## Task 5: `runBrowserInject` signature change + interpolation + executor wiring

**Files:**
- Modify: `src/daemon/bootstrap/recipe-inject.ts` (signature + interpolation call)
- Modify: `src/daemon/bootstrap/recipe-inject.test.ts` (existing tests pass the new arg + 2 new tests)
- Modify: `src/daemon/bootstrap/executor.ts` (call site at ~line 780)

- [ ] **Step 1: Update existing recipe-inject tests to pass the new `dest` arg**

In `src/daemon/bootstrap/recipe-inject.test.ts`, find every `await runBrowserInject(recipe, "ss://...", deps)` call (or similar) and add a `dest` arg. Use a minimal browser_inject dest literal:

```ts
const dest = { kind: "browser_inject" as const, recipe_host: recipe.host, shorthand: "vercel:production", domain: "vercel.test" };
// then: await runBrowserInject(recipe, dest, "ss://stripe/prod/X", deps);
```

The existing tests don't supply `url_params`, so `dest.url_params` is undefined. For those tests to keep passing, the recipe.url must have NO placeholders (Task 6 flips Vercel's URL to `{team}/{project}` — but the test fixture in recipe-inject.test.ts defines its OWN `recipe` constant with a placeholder-free URL like `https://vercel.test/env`, so no interpolation needed). Verify by reading the file's recipe fixture and confirming the URL has no `{name}` tokens.

- [ ] **Step 2: Add 2 new tests**

```ts
test("url_params substitution: open() sees the interpolated URL", async () => {
  // Recipe URL carries placeholders; dest supplies url_params; open() should be called
  // with the substituted URL.
  const recipeWithPlaceholders: InjectRecipe = {
    ...recipe,
    url: "https://vercel.test/{team}/{project}/env",
  };
  let openedWith: string | undefined;
  const { events, deps } = makeDeps({
    present: new Set(["[data-shell]", "[data-in]", "#val", "#save"]),
    successObserved: true,
    proofPassed: true,
  });
  // Wrap the deps.openCaptureTarget to capture the URL it was called with.
  const originalOpen = deps.openCaptureTarget;
  deps.openCaptureTarget = async (cdp: unknown, url: string) => {
    openedWith = url;
    return originalOpen(cdp, url);
  };
  const dest = {
    kind: "browser_inject" as const,
    recipe_host: recipe.host,
    shorthand: "vercel:production",
    domain: "vercel.test",
    url_params: { team: "acme", project: "my-app" },
  };
  const r = await runBrowserInject(recipeWithPlaceholders, dest, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, true);
  assert.equal(openedWith, "https://vercel.test/acme/my-app/env");
});

test("missing url_params: fail-closed with recipe_url_params_missing + ZERO side-effects", async () => {
  const recipeWithPlaceholders: InjectRecipe = {
    ...recipe,
    url: "https://vercel.test/{team}/{project}/env",
  };
  // makeDeps must record EVERY side-effect surface runBrowserInject reaches before
  // the open() call: blind.start, disableObservationDomains, severAgentConnections,
  // openCaptureTarget. The spec (§5 / interpolation-first guarantee) requires
  // interpolation to throw BEFORE any of these fire. See the makeDeps update in
  // Step 0 below — recordable markers are: "blind.start", "blind.end", "open",
  // "severAgentConnections", "disableObservationDomains", "cleanup(close)",
  // "inject", "submit", "proveAbsence", "markUsed".
  const { events, deps } = makeDeps({ present: new Set() });
  const dest = {
    kind: "browser_inject" as const,
    recipe_host: recipe.host,
    shorthand: "vercel:production",
    domain: "vercel.test",
    // url_params intentionally omitted
  };
  const r = await runBrowserInject(recipeWithPlaceholders, dest, "ss://stripe/prod/X", deps);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, "recipe_url_params_missing");
  assert.match(r.message ?? "", /team/); // both missing placeholders named in the message
  assert.match(r.message ?? "", /project/);
  // CRITICAL: zero browser side-effects on the interpolation-fail path. Assert
  // absence for EVERY surface reached before open() in recipe-inject.ts. The spec
  // requires absence of: blind.start, disableObservationDomains (CDP filter),
  // severAgentConnections (proxy sever), openCaptureTarget (tab open), and any
  // downstream marker. Listing them explicitly — not "etc." — so a regression that
  // adds a new pre-interpolation side-effect surface fails this test loudly.
  assert.equal(events.includes("blind.start"), false, "blind.start must NOT fire on interpolation failure");
  assert.equal(events.includes("blind.end"), false, "blind.end must NOT fire on interpolation failure");
  assert.equal(events.includes("disableObservationDomains"), false, "CDP observation filter must NOT be installed");
  assert.equal(events.includes("severAgentConnections"), false, "proxy sever must NOT be invoked");
  assert.equal(events.includes("open"), false, "openCaptureTarget must NOT fire");
  assert.equal(events.includes("cleanup(close)"), false, "cleanup must NOT fire (no target was opened)");
  assert.equal(events.includes("inject"), false, "secret must NOT have been written into the page");
  assert.equal(events.includes("submit"), false, "save must NOT have been clicked");
});
```

> **Step 0 prerequisite — update `makeDeps` fixture so the absence assertions are meaningful.** Today's fixture in `src/daemon/bootstrap/recipe-inject.test.ts` records `blind.start`, `blind.end`, `inject`, `submit`, `proveAbsence`, `markUsed`, and `cleanup(close)` — but `openCaptureTarget`, `severAgentConnections`, and `disableObservationDomains` are silent (open is `async () => ({ target_id: ... })`, sever is `() => undefined`, and the disable call is a module-level import). For the zero-side-effects test to actually prove absence (vs vacuously pass), the fixture needs to record those three. Edit `makeDeps` and `recipe-inject.ts` as follows BEFORE writing the new tests:
>
> 1. **`openCaptureTarget`** — wrap to push `"open"`:
>    `openCaptureTarget: async () => { events.push("open"); return { target_id: over.openTargetId ?? "t" }; }`
> 2. **`severAgentConnections`** — wrap to push `"severAgentConnections"`:
>    `browserSession.proxy.severAgentConnections = () => { events.push("severAgentConnections"); }`
> 3. **`disableObservationDomains`** — make it injectable: add a `disableObservationDomains?: (cdp: CdpClient) => Promise<void>` field to the `deps` type. Default to the real import in `recipe-inject.ts` with: `const disableObservationDomainsImpl = deps.disableObservationDomains ?? disableObservationDomains;` at the top of `runBrowserInject`, then call `await disableObservationDomainsImpl(cdp).catch(() => undefined)` in place of the direct call. In the test fixture's `makeDeps`, provide a wrapper that pushes `"disableObservationDomains"` to events before calling the real import. This mirrors the `open`/`cleanup` pattern already in the file and is < 5 lines of refactor.
>
> Update the existing tests' assertions if any of them relied on the OLD silent `open` (they assert `events.includes("cleanup(close)")` etc., which is unaffected, but double-check `npm run typecheck && node --test` after the fixture change).
>
> All marker strings used in the absence assertions below (`"open"`, `"severAgentConnections"`, `"disableObservationDomains"`) must match what the updated `makeDeps` pushes.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/recipe-inject.test.js"`
Expected:
- The 2 new tests FAIL (signature is still `(recipe, ref, deps)`, and even if you patched the call sites the substitution + fail-closed paths don't exist yet).
- The existing tests may FAIL for the same signature-mismatch reason. That's fine — Step 4 fixes both.

- [ ] **Step 4: Update `runBrowserInject` signature + add interpolation**

In `src/daemon/bootstrap/recipe-inject.ts`:

(a) Import the helper and the type at the top of the file (alongside the existing imports):

```ts
import { interpolateUrl } from "../recipes/url-template.js";
import type { ResolvedDestination } from "./store.js";
```

(b) Change the function signature. Today it's `runBrowserInject(recipe, ref, deps)`. Change to take a `dest` parameter constrained to the browser_inject variant. Use a TypeScript helper type to extract that variant from the union:

```ts
type BrowserInjectDest = Extract<ResolvedDestination, { kind: "browser_inject" }>;

export async function runBrowserInject(
  recipe: InjectRecipe,
  dest: BrowserInjectDest,
  ref: string,
  deps: ExecutorDeps, // or whatever the existing 3rd-arg type was — preserve it verbatim
): Promise<{ ok: boolean; error_code?: string; message?: string }> {
  // INTERPOLATE FIRST — before any side-effect. Convert the helper's throw into a
  // structured per-destination failure so the destination loop continues.
  let interpolatedUrl: string;
  try {
    interpolatedUrl = interpolateUrl(recipe.url, dest.url_params ?? {});
  } catch (e) {
    if (e instanceof ShuttleError && e.code === "recipe_url_params_missing") {
      return { ok: false, error_code: e.code, message: e.message };
    }
    throw e;
  }

  // ... existing function body unchanged, EXCEPT every place that used `recipe.url`
  // now uses `interpolatedUrl`. Today only one site (`open(cdp, recipe.url)` ~line 68
  // of the current file) reads it — change to `open(cdp, interpolatedUrl)`.
}
```

(`ExecutorDeps` may not be the exact name — check the current signature and copy the type verbatim. `ShuttleError` is already imported.)

(c) Find every other read of `recipe.url` in the function (search the file). If there's only one (the `open(cdp, recipe.url)` call), replace it. If there are more, replace all.

- [ ] **Step 5: Update the call site in `executor.ts`**

In `src/daemon/bootstrap/executor.ts`, find the `runBrowserInject` call (around line 780 per the spec). It looks like:

```ts
const r = await runBrowserInject(recipe, ref, deps);
```

Update to pass `dest` (which is the already-resolved `ResolvedDestination` the for-of loop is iterating, narrowed to `browser_inject` via the `if (dest.kind === "browser_inject")` branch):

```ts
const r = await runBrowserInject(recipe, dest, ref, deps);
```

The TypeScript narrowing inside `if (dest.kind === "browser_inject")` already gives `dest` the right type, so no cast needed.

- [ ] **Step 6: Run recipe-inject + executor + plan tests**

Run: `npm run typecheck && npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/bootstrap/recipe-inject.test.js" "dist/daemon/bootstrap/executor.test.js" "dist/daemon/bootstrap/plan.test.js"`
Expected: PASS — all existing tests + the 2 new recipe-inject tests + the Task-4 plan tests.

- [ ] **Step 7: Run the full suite (final regression check)**

Run: `npm test`
Expected: PASS. If any unrelated test broke, it's most likely a fixture that constructed a `browser_inject` destination literal without `url_params` and then exercised it through a recipe URL with placeholders — same fix as the recipe-inject fixture update.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/bootstrap/recipe-inject.ts src/daemon/bootstrap/recipe-inject.test.ts src/daemon/bootstrap/executor.ts
git commit -m "feat(recipes): runBrowserInject interpolates recipe.url before side-effects; fails-closed on missing url_params"
```

---

## Task 6: Flip the Vercel recipe URL to use placeholders

**Files:**
- Modify: `src/daemon/recipes/builtin/vercel-inject.ts`

- [ ] **Step 1: Change the URL + rewrite the doc-comment**

In `src/daemon/recipes/builtin/vercel-inject.ts`, change the `url` field:

```diff
- url: "https://vercel.com/TEAM_PLACEHOLDER/PROJECT_PLACEHOLDER/settings/environment-variables",
+ url: "https://vercel.com/{team}/{project}/settings/environment-variables",
```

Rewrite the URL doc-comment that today explains "this URL is intentionally broken until a dogfood URL lands" to instead reflect the new reality:

> The `{team}` / `{project}` placeholders are substituted at runtime by `interpolateUrl` from the user's yml `url_params`. Missing values fail-closed with `recipe_url_params_missing` BEFORE any browser side-effect — no risk of routing to the wrong project.
>
> Selectors below are still best-effort pending real-page dogfood verification (see `verified_against_real_page` below); URL addressability is decoupled from selector verification.

Keep `verified_against_real_page: "2026-06-01-needs-dogfood"` unchanged.

- [ ] **Step 2: Run the recipe builtin tests + structural test**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/daemon/recipes/builtin/builtin.test.js"`
Expected: PASS — the structural test (all 3 probes + dogfood date) doesn't care about URL content.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS. If a test elsewhere asserted the literal string `TEAM_PLACEHOLDER` in the URL (unlikely but possible), update it.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/recipes/builtin/vercel-inject.ts
git commit -m "feat(recipes): vercel-inject URL uses {team}/{project} placeholders"
```

---

## Task 7: README + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the README provider matrix**

In `README.md`, find the Vercel row in the Provider Coverage matrix (around line 146-147). Replace the Status + Notes cells:

- **Status (was)**: `CLI shipped; recipe ⬜ placeholder (not dogfooded)` (or similar — read the current value first).
- **Status (new)**: `CLI shipped; browser recipe URL-configurable — set url_params: {team, project} in yml (selectors still best-effort, pending dogfood)`
- **Notes (was)**: contains a sentence about `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` opt-in.
- **Notes (new)**: drop the SCOPES sentence; KEEP the "selectors pending dogfood" caveat.

- [ ] **Step 2: Scrub any other `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` mention**

```bash
grep -n "SECRET_SHUTTLE_INJECT_RECIPE_SCOPES" README.md
```

Each match → delete the sentence/clause that references it. The env var no longer exists; documenting it is misleading.

- [ ] **Step 3: Add the CHANGELOG entry**

In `CHANGELOG.md` under `## Unreleased`, add:

```markdown
### Added — Recipe URL interpolation

- **`browser_inject` recipe URL is now templatable.** Recipe `url` carries `{name}` placeholders (e.g., `https://vercel.com/{team}/{project}/settings/environment-variables`); users supply `url_params: { team, project }` per destination in their yml. The Vercel inject recipe flips from a `TEAM_PLACEHOLDER`/`PROJECT_PLACEHOLDER` literal URL to the templated form — addressable for any user's Vercel team+project (selectors still pending real-page dogfood; URL addressability is decoupled).
- **yml destination grammar extended.** Each entry in `destinations:` is now EITHER a string shorthand (back-compat, identical behavior) OR a `{ shorthand, url_params? }` object. Unknown object keys, missing/non-string `shorthand`, non-mapping `url_params`, and non-string `url_params` values all fail-closed with `bootstrap_plan_invalid`.
- **`recipe_url_params_missing` error code.** Thrown by the new `interpolateUrl` helper when any `{name}` placeholder has no own-property non-empty string in `params` (covers missing keys, inherited properties like `toString`, non-strings, and empty strings — empty strings would otherwise produce malformed URL path segments). `runBrowserInject` converts the throw into a per-destination `{ ok: false, error_code }` so a bad `url_params` on destination N reports as a destination-N failure without aborting destinations N+1…M. Interpolation runs BEFORE any browser side-effect (no `blind.start`, no `open`, no CDP filtering) so a config-only failure cannot leave a half-state.

### Removed — `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` allowlist (cleanup)

- The env-var allowlist Burst 8 Task 14 introduced (§200 scope-specific coverage guard) is gone. It existed to prevent the static-URL recipe from silently pushing a user's secret into the dogfood project URL. With URL interpolation, the recipe addresses the user's actual project — or fails-closed with `recipe_url_params_missing`. The hazard is structurally closed; the gate became friction.
- Files affected: `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` env read in `src/daemon/api/routes/bootstrap.ts`, the `destinationCovered` helper + its tests, `PlanSelection.coversDestination`, and the §200 host-only-insufficient plan test — all removed.

### Behavior change (string-form yml + Vercel CLI absent)

Before this release, a string-form `vercel:<env>` destination with the Vercel CLI absent would either (a) be kept on the CLI template path by `SECRET_SHUTTLE_INJECT_RECIPE_SCOPES` (and then fail later with a CLI-missing error) or (b) return `browser_inject_not_implemented` from the Burst 8 stub. After this release, the same destination selects `browser_inject` and fails-closed with `recipe_url_params_missing` because the string form supplies no `url_params`.

**Two ways to fix an existing setup:**
1. Install + authenticate the vendor CLI (`vercel login`) so the template path activates as before. OR
2. Convert the destination to object form and supply the params: `{ shorthand: "vercel:production", url_params: { team: "acme", project: "my-app" } }` so the browser recipe routes correctly.
```

(Read the current top of `CHANGELOG.md` first — the `## Unreleased` section may already have other entries. Insert the new block ABOVE existing Unreleased entries so the most recent change is at the top.)

- [ ] **Step 4: Run the demo-command-scan drift guard (paranoia)**

Run: `npm run build && SECRET_SHUTTLE_NO_OPEN_URL=1 node --test "dist/e2e/demo-command-scan.test.js"`
Expected: PASS — no new commands or flags introduced.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: README provider matrix + CHANGELOG for recipe URL interpolation + §200 cleanup"
```

---

## Final verification (run after Task 7, before the impl gate)

- [ ] **Full suite green:**

Run: `npm test`
Expected: PASS. Baseline at start of Burst 9 was 1712 / 0 / 18; after this plan expect ≈1748 / 0 / 18 (added: 11 url-template + 23 yml + 1 error-code + 3 plan + 2 recipe-inject ≈ 40; dropped: 3 destinationCovered + 1 §200 plan = 4; net ≈ +36).

- [ ] **§200 leftovers fully gone:**

Run: `git grep -i "SECRET_SHUTTLE_INJECT_RECIPE_SCOPES\|coveredScopes\|destinationCovered\|coversDestination"`
Expected: only matches inside `.codex-gate/` (review artifacts), the spec/plan docs (historical context), and CHANGELOG (documenting the removal). NO matches in `src/` or `README.md` or `docs/` outside the spec/plan files.

- [ ] **Spec-vs-impl spot check:**

Confirm the §3 OMITTED rule: in a test or REPL, `parseBootstrapYml` a string-form destination and assert the persisted object has no `url_params` key (not even `url_params: undefined`). Same check for the `browser_inject` ResolvedDestination produced by `computeBootstrapPlan` for the same input. The spec is unambiguous about field omission; the plan's tests cover it but a manual spot-check is cheap.

- [ ] **Manual dogfood (the real-page bar §10):** once the Vercel selectors are real-page verified by a human, run a `provision --infer → --continue` against a yml with `url_params: { team: <your-team>, project: <your-project> }` and confirm the bootstrap browser opens the correct URL. Recipes still ship with `verified_against_real_page: "2026-06-01-needs-dogfood"` until that happens — interpolation is independent of selector dogfood.

---

## Self-review notes (writing-plans skill)

**Spec coverage:** Every section of the spec has a task —
- §1 goal/non-goals → Tasks 2 + 4 + 5 + 6 (the goal); non-goals are not implemented (correctly omitted).
- §2 types → Task 4 (plan.ts uses the existing union shape; no new fields).
- §3 yml schema → Task 3.
- §4 pipeline → Tasks 3 + 4 + 5.
- §5 interpolateUrl → Task 2.
- §6 vercel-inject URL → Task 6.
- §7 §200 cleanup → Task 4.
- §8 error code → Task 1.
- §9 tests → covered task-by-task at each TDD step.
- §10 docs → Task 7.
- Documented behavior change → Task 7 CHANGELOG entry explicitly calls it out.

**Placeholder scan:** No "TBD" / "TODO" / "fill in later". Every code step shows the actual code; every command shows the actual command + expected output.

**Type consistency:** `runBrowserInject(recipe, dest, ref, deps)` signature is the same in Task 5 spec + executor call-site + the new tests. `BootstrapPlanSecret.destinations` shape (`{shorthand, url_params?}[]`) is the same in Task 3 type def + Task 4 plan-test fixture literals + Task 5 recipe-inject test `dest` literal. `interpolateUrl(template, params)` signature is the same in Task 2 helper + Task 5 caller. `recipe_url_params_missing` code spelled identically in error-codes.ts (Task 1), url-template.ts throw (Task 2), recipe-inject conversion (Task 5), CHANGELOG (Task 7).
