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
