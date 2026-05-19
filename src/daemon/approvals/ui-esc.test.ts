import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// ui.html is the human's sole trust surface for approving inject_submit. Its
// security guarantee is that every grant-derived value rendered into the DOM is
// wrapped in the in-page esc() escaper. That escaper had zero automated
// coverage (review item I1). This test reads the REAL served ui.html, extracts
// its ACTUAL esc() source, evaluates it, and asserts hostile inputs are
// neutralized -- mirroring the Phase-1 precedent in
// chrome/normalize-to-actionable.test.ts (eval the real served fn string
// against a shim). Reading the served file means no drift risk and no new deps.

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

// Extract the `const esc = <arrow-expr>;` definition from the served file.
// Capture group 1 is the arrow expression between `=` and the line-final `;`.
// The regex is anchored to a single line (esc is defined on one line) and the
// statement-terminating `;` at end of line, so it tolerates the regex literal
// and nested parens/braces inside the body without a brace-matcher.
const ESC_RE = /^\s*const esc\s*=\s*(.+);\s*$/m;

async function loadEsc(): Promise<(s: unknown) => string> {
  const html = await readFile(UI, "utf8");
  const m = html.match(ESC_RE);
  // If esc is renamed/removed/reshaped this throws -> the test FAILS loudly
  // (drift is caught), it does not silently pass.
  if (!m || !m[1]) {
    throw new Error(
      "ui-esc.test: could not extract `const esc = ...;` from served ui.html. " +
        "The trust-surface escaper was renamed/removed/reshaped -- update this " +
        "regression test and re-verify the escaping guarantee.",
    );
  }
  const escSource = m[1];
  return new Function("return (" + escSource + ")")() as (s: unknown) => string;
}

test("ui-esc: the regex extracts a callable esc from the served ui.html (drift guard)", async () => {
  const esc = await loadEsc();
  assert.equal(typeof esc, "function");
  // Sanity: it actually escapes (not e.g. an identity fn captured by mistake).
  assert.equal(esc("<"), "&lt;");
});

test("ui-esc: missing/renamed esc makes extraction FAIL loudly, not silently pass", () => {
  // Same extraction logic against a doctored copy with esc renamed away.
  const doctored =
    '<script type="module">\n      const notEsc = (s) => String(s);\n</script>';
  const m = doctored.match(ESC_RE);
  assert.equal(m, null, "regex must not match when `const esc =` is absent");
  // loadEsc() would throw on this -> proves drift is caught.
});

test("ui-esc: neutralizes a script-injection payload (no raw < > or <script>)", async () => {
  const esc = await loadEsc();
  const out = esc("</code><script>alert(1)</script>");
  assert.ok(!out.includes("<script>"), "must not contain a literal <script>");
  assert.ok(!out.includes("<"), "all < must become &lt;");
  assert.ok(!out.includes(">"), "all > must become &gt;");
  assert.equal(
    out,
    "&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});

test("ui-esc: escapes attribute-breakout chars (\" and ')", async () => {
  const esc = await loadEsc();
  assert.equal(esc('" onmouseover=x'), "&quot; onmouseover=x");
  assert.equal(esc("'"), "&#39;");
  assert.equal(esc("&"), "&amp;");
});

test("ui-esc: escapes every special char in a mixed string", async () => {
  const esc = await loadEsc();
  assert.equal(esc("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&#39;");
});

test("ui-esc: leaves a benign string unchanged", async () => {
  const esc = await loadEsc();
  assert.equal(esc("Environment Variable Added"), "Environment Variable Added");
});
