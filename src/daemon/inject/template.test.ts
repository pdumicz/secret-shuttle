import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTemplate } from "./template.js";

// NOTE on canonical ref forms:
// The plan's spec text (verbatim block in Task D1, Step 1) used the LONG
// environment form (e.g. `ss://stripe/production/STRIPE_KEY`) for the expected
// `refs` values. But `parseSecretRef(...).ref` round-trips through
// `buildSecretRef`, which uses `refEnvironment(...)` to emit the SHORT form
// (`prod`/`dev`) — see src/shared/refs.ts and the assertion in
// src/shared/refs.test.ts ("parseSecretRef normalizes production long form").
// So the canonical ref is the SHORT form. The expected values below match the
// real `parseSecretRef` output, not the long-form text in the plan prose.

test("parseTemplate: finds all ss:// refs (deduped)", () => {
  const t = "key: ss://stripe/prod/STRIPE_KEY\nother: ss://stripe/prod/STRIPE_KEY\n";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://stripe/prod/STRIPE_KEY"]); // canonicalized via parseSecretRef (short form)
});

test("parseTemplate: render substitutes refs with provided values", () => {
  const t = "key: ss://stripe/prod/STRIPE_KEY";
  const { render } = parseTemplate(t);
  // The MAP key is the CANONICAL ref (matches what was returned in .refs) — short form.
  const out = render(new Map([["ss://stripe/prod/STRIPE_KEY", "sk_live_abc"]]));
  assert.equal(out, "key: sk_live_abc");
});

test("parseTemplate: render throws if a ref's value is missing", () => {
  const t = "key: ss://x/dev/MISSING";
  const { render } = parseTemplate(t);
  assert.throws(() => render(new Map()), /MISSING/);
});

test("parseTemplate: NAME_RE-valid mixed-case names parse correctly", () => {
  // The canonical NAME_RE allows [A-Za-z_][A-Za-z0-9_.-]*, so lowercase + dashes work.
  const t = "config: ss://x/dev/A_extra-thing.v2";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://x/dev/A_extra-thing.v2"]);
});

test("parseTemplate: candidate followed by NAME_RE-invalid suffix → match ends at suffix boundary", () => {
  // Trailing '=' is NOT in NAME_RE; the match stops at A.
  const t = "key: ss://x/dev/A=somethingelse";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, ["ss://x/dev/A"]);
  // ... and the rendered text keeps the '=somethingelse' suffix verbatim:
  const { render } = parseTemplate(t);
  assert.equal(
    render(new Map([["ss://x/dev/A", "RESOLVED"]])),
    "key: RESOLVED=somethingelse",
  );
});

test("parseTemplate: candidate that fails parseSecretRef → left as literal (no partial substitution)", () => {
  // ss://x/dev/ followed by nothing — invalid (empty NAME). The candidate fails
  // parseSecretRef and stays as literal text.
  const t = "broken: ss://x/dev/";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, []);
  const { render } = parseTemplate(t);
  assert.equal(render(new Map()), "broken: ss://x/dev/");
});

test("parseTemplate: 'ss://' with no trailing chars is not a match", () => {
  const t = "see: ss:// for refs";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs, []);
});

test("parseTemplate: empty template has no refs", () => {
  const { refs } = parseTemplate("");
  assert.deepEqual(refs, []);
});

test("parseTemplate: multiple distinct refs preserved", () => {
  const t = "a: ss://src1/dev/A\nb: ss://src2/prod/B\n";
  const { refs } = parseTemplate(t);
  assert.deepEqual(refs.sort(), [
    "ss://src1/dev/A",
    "ss://src2/prod/B",
  ]);
});
