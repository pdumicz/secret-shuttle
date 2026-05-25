import { test } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectAgentRuntimes } from "./agent-runtime-detect.js";

test("detectAgentRuntimes: empty dir → []", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  assert.deepStrictEqual(await detectAgentRuntimes(dir), []);
});

test("detectAgentRuntimes: .claude/ → ['claude']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["claude"]);
});

test("detectAgentRuntimes: AGENTS.md → ['codex']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await writeFile(path.join(dir, "AGENTS.md"), "# agents\n");
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["codex"]);
});

test("detectAgentRuntimes: .cursor/ → ['cursor']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".cursor"), { recursive: true });
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["cursor"]);
});

test("detectAgentRuntimes: .github/copilot-instructions.md → ['copilot']", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".github"), { recursive: true });
  await writeFile(path.join(dir, ".github/copilot-instructions.md"), "# copilot\n");
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["copilot"]);
});

test("detectAgentRuntimes: multiple → sorted alphabetically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-detect-"));
  await mkdir(path.join(dir, ".claude"), { recursive: true });
  await mkdir(path.join(dir, ".cursor"), { recursive: true });
  assert.deepStrictEqual(await detectAgentRuntimes(dir), ["claude", "cursor"]);
});
