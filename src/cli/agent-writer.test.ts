import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeAgentFile, writeAgentSnippet } from "./agent-writer.js";

const BEGIN = "<!-- secret-shuttle:begin -->";
const END = "<!-- secret-shuttle:end -->";

async function tmpRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "ss-agent-writer-"));
}

test("writeAgentFile creates a new file with exact content and 0644 mode", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "sub", "dir", "SKILL.md");
  await writeAgentFile({ targetPath: target, content: "hello\n" });
  assert.equal(await readFile(target, "utf8"), "hello\n");
  const st = await stat(target);
  assert.equal((st.mode & 0o777).toString(8), "644");
});

test("writeAgentFile overwrites an existing file wholesale", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "SKILL.md");
  await writeFile(target, "OLD-SENTINEL\noriginal content\n");
  await writeAgentFile({ targetPath: target, content: "NEW\n" });
  const got = await readFile(target, "utf8");
  assert.equal(got, "NEW\n");
  assert.ok(!got.includes("OLD-SENTINEL"));
});

test("writeAgentSnippet creates a new file with just the marked block when target is missing", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "deep", "AGENTS.md");
  await writeAgentSnippet({ targetPath: target, content: "body\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  assert.equal(got, `${BEGIN}\nbody\n${END}\n`);
});

test("writeAgentSnippet round-trip replaces ONLY the marked block on second run", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  const pre = "SENTINEL-BEFORE\n\n<!-- secret-shuttle:begin -->\nOLD\n<!-- secret-shuttle:end -->\n\nSENTINEL-AFTER\n";
  await writeFile(target, pre);
  await writeAgentSnippet({ targetPath: target, content: "NEW BODY\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  assert.equal(
    got,
    "SENTINEL-BEFORE\n\n<!-- secret-shuttle:begin -->\nNEW BODY\n<!-- secret-shuttle:end -->\n\nSENTINEL-AFTER\n",
  );
  assert.ok(!got.includes("OLD"));
  assert.ok(got.includes("SENTINEL-BEFORE"));
  assert.ok(got.includes("SENTINEL-AFTER"));
});

test("writeAgentSnippet appends a new block when the existing file lacks markers", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  await writeFile(target, "USER-CONTENT\n");
  await writeAgentSnippet({ targetPath: target, content: "ours\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  assert.equal(got, `USER-CONTENT\n\n\n${BEGIN}\nours\n${END}\n`);
});

test("writeAgentSnippet treats begin-without-end as 'lacks markers' (appends a new block, leaves the malformed half alone)", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  await writeFile(target, `USER-CONTENT\n${BEGIN}\nORPHAN\n`);
  await writeAgentSnippet({ targetPath: target, content: "ours\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  assert.ok(got.includes("ORPHAN"));
  assert.ok(got.endsWith(`${BEGIN}\nours\n${END}\n`));
});

test("writeAgentSnippet running twice with same content is byte-identical (idempotent)", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  await writeAgentSnippet({ targetPath: target, content: "same\n", beginMarker: BEGIN, endMarker: END });
  const after1 = await readFile(target, "utf8");
  await writeAgentSnippet({ targetPath: target, content: "same\n", beginMarker: BEGIN, endMarker: END });
  const after2 = await readFile(target, "utf8");
  assert.equal(after1, after2);
});

test("writeAgentSnippet mkdir-p creates a missing parent directory", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "a", "b", "c", "AGENTS.md");
  await writeAgentSnippet({ targetPath: target, content: "body\n", beginMarker: BEGIN, endMarker: END });
  assert.equal(await readFile(target, "utf8"), `${BEGIN}\nbody\n${END}\n`);
});
