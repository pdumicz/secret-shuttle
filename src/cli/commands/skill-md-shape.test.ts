import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SKILL_PATH = join(process.cwd(), "skills/secret-shuttle/SKILL.md");

test("SKILL.md above-the-fold is ≤ 65 lines (≤60 + slack)", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  const lines = content.split("\n");
  // First `---` line that's NOT the YAML frontmatter opener (line 0).
  // Using the (l, i) form rather than lines.indexOf(l) > 0, because the
  // latter would find the first occurrence of the string "---" in the
  // whole array — that always returns the line we're testing, so the
  // filter degenerates.
  const fenceIdx = lines.findIndex((l, i) => l.trim() === "---" && i > 0);
  assert.ok(
    fenceIdx > 0 && fenceIdx <= 65,
    `above-the-fold spans ${fenceIdx} lines (target ≤65)`,
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
