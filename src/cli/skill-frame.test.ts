import { test } from "node:test";
import assert from "node:assert/strict";
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

// The fixture description is deliberately free of YAML-special chars (`:`, `#`,
// leading `-`), so `yaml` emits it unquoted and this hardcoded byte-exact block
// stays valid. A description with special chars would be quoted and break the
// literal equality below — change the fixture and this block together.
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

test("frameSkillForTarget throws when name key is absent", () => {
  // Absent key is a distinct input class from blank/non-string: `data.name` is
  // `undefined`, which the `typeof !== "string"` guard must still reject.
  assertInvalid("---\ndescription: ok desc\n---\n\nbody\n", "absent name key");
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

test("frameSkillForTarget throws when description is a non-string value (mapping)", () => {
  // Spec Testing §5 calls out number/list/mapping; a nested mapping value must
  // also fail closed (it would otherwise serialize to a non-string `.mdc` desc).
  assertInvalid("---\nname: secret-shuttle\ndescription:\n  text: ok desc\n---\n\nbody\n", "mapping description");
});

test("frameSkillForTarget throws when description contains an embedded newline", () => {
  // A YAML block scalar produces a multi-line string value.
  const raw = "---\nname: secret-shuttle\ndescription: |\n  line one\n  line two\n---\n\nbody\n";
  assertInvalid(raw, "multi-line description must fail closed");
});

test("frameSkillForTarget throws on present-but-malformed YAML frontmatter", () => {
  assertInvalid("---\nname: {unterminated\n---\n\nbody\n", "malformed YAML fence");
});
