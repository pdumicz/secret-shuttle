import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Resolve the built CLI relative to this test file's location.
// Build emits to dist/, and node --test runs tests from dist/, so:
//   __filename = dist/e2e/agent-install-no-leak.test.js
//   CLI       = dist/cli/index.js
const CLI = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "cli", "index.js");

const BEGIN = "<!-- secret-shuttle:begin -->";
const END = "<!-- secret-shuttle:end -->";

test("e2e: agent install writes each target's file to CWD with correct write mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ss-agent-e2e-"));

  // claude — wholesale
  let r = spawnSync("node", [CLI, "agent", "install", "claude"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install claude failed: ${r.stderr}`);
  const claudeFile = path.join(root, ".claude/skills/secret-shuttle/SKILL.md");
  const claudeContent = await readFile(claudeFile, "utf8");
  // claude framing is wholesale-verbatim: the canonical SKILL.md now leads with
  // YAML frontmatter (discoverability), so the file starts with `---` and keeps
  // both the `name:` key and the `# Secret Shuttle` body heading.
  assert.ok(claudeContent.startsWith("---"), "claude install keeps the SKILL.md frontmatter fence");
  assert.ok(claudeContent.includes("name: secret-shuttle"), "claude install keeps the skill name frontmatter");
  assert.ok(claudeContent.includes("# Secret Shuttle"), "claude install keeps the SKILL.md body");

  // codex — snippet
  await writeFile(path.join(root, "AGENTS.md"), "USER-SENTINEL-BEFORE\n");
  r = spawnSync("node", [CLI, "agent", "install", "codex"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install codex failed: ${r.stderr}`);
  let agentsContent = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(agentsContent.includes("USER-SENTINEL-BEFORE"), "codex install must preserve pre-existing AGENTS.md content");
  assert.ok(agentsContent.includes(BEGIN), "codex install must write the begin marker");
  assert.ok(agentsContent.includes(END), "codex install must write the end marker");

  // codex idempotent — exactly one marked block after second run
  r = spawnSync("node", [CLI, "agent", "install", "codex"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install codex (2nd run) failed: ${r.stderr}`);
  agentsContent = await readFile(path.join(root, "AGENTS.md"), "utf8");
  const beginCount = (agentsContent.match(new RegExp(BEGIN.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
  const endCount = (agentsContent.match(new RegExp(END.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
  assert.equal(beginCount, 1, "exactly one begin marker after two installs");
  assert.equal(endCount, 1, "exactly one end marker after two installs");

  // cursor — wholesale
  r = spawnSync("node", [CLI, "agent", "install", "cursor"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install cursor failed: ${r.stderr}`);
  const cursorContent = await readFile(path.join(root, ".cursor/rules/secret-shuttle.mdc"), "utf8");
  // cursor framing rewrites the skill into Cursor's `.mdc` rule shape: a
  // `description`/`globs`/`alwaysApply` frontmatter block (NO skill `name:`),
  // then the body. See frameSkillForTarget in src/cli/skill-frame.ts.
  assert.ok(cursorContent.startsWith("---\ndescription: "), "cursor install writes the .mdc frontmatter");
  assert.ok(cursorContent.includes("\nglobs:\n"), "cursor .mdc has a blank globs line");
  assert.ok(cursorContent.includes("\nalwaysApply: false\n"), "cursor .mdc sets alwaysApply: false");
  assert.ok(!cursorContent.includes("name: secret-shuttle"), "cursor .mdc strips the skill name frontmatter");
  assert.ok(cursorContent.includes("# Secret Shuttle"), "cursor install preserves the SKILL.md body");

  // copilot — snippet
  r = spawnSync("node", [CLI, "agent", "install", "copilot"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, `agent install copilot failed: ${r.stderr}`);
  const copilotContent = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
  assert.ok(copilotContent.includes(BEGIN));
  assert.ok(copilotContent.includes(END));
});

test("e2e: agent install rejects an unknown target with a non-zero exit code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ss-agent-e2e-bad-"));
  const r = spawnSync("node", [CLI, "agent", "install", "atom"], { cwd: root, encoding: "utf8" });
  assert.notEqual(r.status, 0, "unknown target must fail with non-zero exit code");
  assert.match(r.stderr, /bad_request|must be one of/);
});

test("e2e: agent print-skill-url prints the derived URL on stdout (default branch=main)", async () => {
  const r = spawnSync("node", [CLI, "agent", "print-skill-url"], { encoding: "utf8" });
  assert.equal(r.status, 0, `agent print-skill-url failed: ${r.stderr}`);
  assert.match(r.stdout, /https:\/\/raw\.githubusercontent\.com\/[^\/]+\/secret-shuttle\/main\/skills\/secret-shuttle\/SKILL\.md/);
  assert.equal(r.stdout.trim().split("\n").length, 1, "print-skill-url emits exactly one URL line");
});

test("e2e: agent print-skill-url honors --branch override", async () => {
  const r = spawnSync("node", [CLI, "agent", "print-skill-url", "--branch", "feat/skill-installers"], { encoding: "utf8" });
  assert.equal(r.status, 0, `agent print-skill-url --branch failed: ${r.stderr}`);
  assert.match(r.stdout, /\/feat\/skill-installers\/skills\/secret-shuttle\/SKILL\.md/);
});
