import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SKILL_PATH = join(process.cwd(), "skills/secret-shuttle/SKILL.md");

test("SKILL.md above-the-fold is ≤ 70 lines (≤60 body + nudge + slack)", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  const lines = content.split("\n");
  // The file now opens with a YAML frontmatter block (`---` … `---`). We must
  // skip BOTH frontmatter fences and measure the real body's above-the-fold
  // span (the body/reference divider), otherwise the guard would lock onto the
  // CLOSING frontmatter fence (~line 3) and pass vacuously no matter how large
  // the body grows.
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    // close === -1 means a malformed (unterminated) frontmatter block — the
    // skill-frame validation/discoverability tests already fail-closed on that,
    // so here we just fall back to measuring from the top.
    if (close > 0) bodyStart = close + 1;
  }
  // First `---` divider in the BODY (strictly after the frontmatter block):
  // its index in the sliced body IS the above-the-fold span. -1 (no divider)
  // fails the `> 0` check below, which is the correct outcome for that case.
  const bodySpan = lines.slice(bodyStart).findIndex((l) => l.trim() === "---");
  assert.ok(
    bodySpan > 0 && bodySpan <= 70,
    `body above-the-fold spans ${bodySpan} lines (target ≤70)`,
  );
});

test("SKILL.md quickstart uses `provision` not `bootstrap`", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  assert.match(content, /provision --infer/);
  // The `bootstrap` verb was removed in §1 of Burst 5. The SKILL.md must
  // not invoke it as a top-level command. We match at the start of a
  // line (allowing leading whitespace) to catch code-block usages
  // without false-positiving on the word "bootstrap" in prose.
  assert.doesNotMatch(content, /^\s*secret-shuttle bootstrap\b/m);
});

test("SKILL.md error table includes top-tier codes", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  for (const code of [
    "daemon_not_running",
    "vault_locked",
    "approval_required",
    "secret_not_found",
    "infer_no_env_example",
  ]) {
    assert.match(content, new RegExp(code), `error table missing ${code}`);
  }
});
