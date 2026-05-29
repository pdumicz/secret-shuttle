// src/e2e/skill-md-toplevel-absent.test.ts
//
// Burst 6 §1.1 drift-guard. The canonical agent skill lives at
// skills/secret-shuttle/SKILL.md (the in-skills/ copy). A top-level
// SKILL.md in this repo would ship to npm consumers alongside the
// canonical copy and could drift — e.g., the Burst 5 §3 restructure
// only updated the in-skills/ copy, so the deleted top-level still
// referenced the removed `bootstrap` verb until §1.1 of Burst 6
// removed it. This test prevents accidental re-introduction.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("top-level SKILL.md must not exist (canonical skill is at skills/secret-shuttle/SKILL.md)", () => {
  const path = join(process.cwd(), "SKILL.md");
  assert.equal(
    existsSync(path),
    false,
    "Top-level SKILL.md re-introduced. Delete it; the canonical skill is at skills/secret-shuttle/SKILL.md. See Burst 6 §1.1.",
  );
});
