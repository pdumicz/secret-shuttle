import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { agentInstallTarget, agentPrintSkillUrl } from "./agent.js";

const BEGIN = "<!-- secret-shuttle:begin -->";
const END = "<!-- secret-shuttle:end -->";

async function tmpCwd(): Promise<{ root: string; restore: () => void }> {
  const root = await mkdtemp(path.join(tmpdir(), "ss-agent-cli-"));
  const orig = process.cwd();
  process.chdir(root);
  return { root, restore: () => process.chdir(orig) };
}

const FAKE_BODY = "# Fake Skill\nbody\n";
const FAKE_SKILL_CONTENT = [
  "---",
  "name: secret-shuttle",
  "description: Use secret refs without plaintext",
  "---",
  "",
  FAKE_BODY,
].join("\n");

test("agentInstallTarget('claude') writes wholesale to .claude/skills/secret-shuttle/SKILL.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("claude", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".claude/skills/secret-shuttle/SKILL.md"), "utf8");
    assert.equal(out, FAKE_SKILL_CONTENT);
  } finally { restore(); }
});

test("agentInstallTarget('cursor') writes a framed .mdc rule (description/globs/alwaysApply, no skill frontmatter)", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("cursor", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".cursor/rules/secret-shuttle.mdc"), "utf8");
    assert.ok(out.startsWith("---\ndescription: "), "starts with .mdc frontmatter");
    assert.ok(out.includes("\nglobs:\n"), "blank globs line");
    assert.ok(out.includes("\nalwaysApply: false\n"), "alwaysApply: false");
    assert.ok(!out.includes("name: secret-shuttle"), "skill frontmatter stripped");
    assert.ok(out.includes(FAKE_BODY), "body preserved");
  } finally { restore(); }
});

test("agentInstallTarget('codex') writes a frontmatter-stripped body in markers to AGENTS.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.ok(out.startsWith(BEGIN));
    assert.ok(out.includes(FAKE_BODY), "body preserved");
    // No skill frontmatter (and therefore no `---` fence) inside the snippet.
    const between = out.slice(out.indexOf(BEGIN) + BEGIN.length, out.indexOf(END));
    assert.ok(!between.includes("name: secret-shuttle"), "frontmatter stripped");
    assert.ok(!between.trimStart().startsWith("---"), "no leading frontmatter fence in snippet");
    assert.ok(out.endsWith(`${END}\n`));
  } finally { restore(); }
});

test("agentInstallTarget('copilot') writes a frontmatter-stripped body in markers to .github/copilot-instructions.md", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("copilot", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
    assert.ok(out.includes(BEGIN));
    assert.ok(out.includes(FAKE_BODY), "body preserved");
    assert.ok(!out.includes("name: secret-shuttle"), "frontmatter stripped");
  } finally { restore(); }
});

test("agentInstallTarget('codex') is idempotent — exactly one marked block after two runs", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, "AGENTS.md"), "utf8");
    const beginCount = (out.match(new RegExp(BEGIN.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
    const endCount = (out.match(new RegExp(END.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")) ?? []).length;
    assert.equal(beginCount, 1);
    assert.equal(endCount, 1);
  } finally { restore(); }
});

test("agentInstallTarget('codex') preserves preexisting AGENTS.md content outside the block", async () => {
  const { root, restore } = await tmpCwd();
  try {
    await writeFile(path.join(root, "AGENTS.md"), "USER-CONTENT-BEFORE\n");
    await agentInstallTarget("codex", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.ok(out.includes("USER-CONTENT-BEFORE"));
    assert.ok(out.includes(BEGIN));
  } finally { restore(); }
});

test("agentInstallTarget('claude') is wholesale-overwrite", async () => {
  const { root, restore } = await tmpCwd();
  try {
    const dest = path.join(root, ".claude/skills/secret-shuttle/SKILL.md");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, "OLD-SENTINEL\n");
    await agentInstallTarget("claude", { skillContent: FAKE_SKILL_CONTENT, cwd: root });
    const out = await readFile(dest, "utf8");
    assert.ok(!out.includes("OLD-SENTINEL"));
    assert.equal(out, FAKE_SKILL_CONTENT);
  } finally { restore(); }
});

test("agentPrintSkillUrl returns the derived URL with default branch=main", () => {
  const url = agentPrintSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    {},
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("agentPrintSkillUrl honors --branch override", () => {
  const url = agentPrintSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    { branch: "feat/x" },
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/feat/x/skills/secret-shuttle/SKILL.md");
});
