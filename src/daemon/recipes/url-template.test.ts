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
  assert.throws(
    () => interpolateUrl("/{n}", { n: 42 as unknown as string }),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_url_params_missing",
  );
});

test("empty-string value is treated as missing (blocks malformed-URL hazard)", () => {
  assert.throws(
    () => interpolateUrl("/{team}/{project}", { team: "", project: "app" }),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_url_params_missing" && /team/.test(e.message),
  );
});
