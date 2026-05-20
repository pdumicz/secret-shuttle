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

test("writeAgentSnippet refuses when the file has multiple begin markers (snippet_ambiguous)", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  // Two well-formed blocks (e.g. from a previous double-paste)
  await writeFile(target,
    `${BEGIN}\nA\n${END}\n${BEGIN}\nB\n${END}\n`,
  );
  const { ShuttleError } = await import("../shared/errors.js");
  await assert.rejects(
    () => writeAgentSnippet({ targetPath: target, content: "X\n", beginMarker: BEGIN, endMarker: END }),
    (e: unknown) => e instanceof ShuttleError && (e as { code?: string }).code === "snippet_ambiguous",
  );
});

test("writeAgentSnippet idempotent under the orphan-begin scenario: 2nd install does NOT delete user content between orphan begin and the appended block", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  // Orphan begin (no end) followed by user content
  await writeFile(target,
    `USER-LINE\n${BEGIN}\nORPHAN-BEGIN-NO-END\nMORE-USER-CONTENT\n`,
  );
  // First install: should append a well-formed block. With the orphan begin in
  // place, there is now 1 line-anchored BEGIN (the orphan) + 0 line-anchored END
  // BEFORE the install. After the install there are 2 BEGINs and 1 END → the
  // sanitize check rejects the SECOND install (snippet_ambiguous). That refusal
  // is the correct fail-closed: the file is in a state that requires manual
  // repair, and the user's content is preserved verbatim.
  await writeAgentSnippet({ targetPath: target, content: "first\n", beginMarker: BEGIN, endMarker: END });
  const after1 = await readFile(target, "utf8");
  assert.ok(after1.includes("USER-LINE"));
  assert.ok(after1.includes("ORPHAN-BEGIN-NO-END"));
  assert.ok(after1.includes("MORE-USER-CONTENT"));
  // Now run install a 2nd time. We expect snippet_ambiguous — the file has 2
  // begin markers (the orphan + the new appended one), so manual repair is
  // required. User content is preserved by the refusal.
  const { ShuttleError } = await import("../shared/errors.js");
  await assert.rejects(
    () => writeAgentSnippet({ targetPath: target, content: "second\n", beginMarker: BEGIN, endMarker: END }),
    (e: unknown) => e instanceof ShuttleError && (e as { code?: string }).code === "snippet_ambiguous",
  );
  // Confirm the file on disk is byte-identical to after1 (no partial write).
  const after2 = await readFile(target, "utf8");
  assert.equal(after2, after1);
  // And the user content is still present.
  assert.ok(after2.includes("USER-LINE"));
  assert.ok(after2.includes("ORPHAN-BEGIN-NO-END"));
  assert.ok(after2.includes("MORE-USER-CONTENT"));
});

test("writeAgentSnippet ignores marker syntax inline in user content (only line-anchored markers count)", async () => {
  const root = await tmpRoot();
  const target = path.join(root, "AGENTS.md");
  // User documentation that mentions the marker syntax inline as an example
  await writeFile(target,
    `README example: to install paste this: ${BEGIN} ... ${END}\nMORE-USER-DOCS\n`,
  );
  await writeAgentSnippet({ targetPath: target, content: "ours\n", beginMarker: BEGIN, endMarker: END });
  const got = await readFile(target, "utf8");
  // The inline mention is preserved verbatim — the line-anchored matcher did not see those as managed markers.
  assert.ok(got.includes(`README example: to install paste this: ${BEGIN} ... ${END}`));
  assert.ok(got.includes("MORE-USER-DOCS"));
  // A new well-formed block is appended at EOF.
  assert.ok(got.endsWith(`${BEGIN}\nours\n${END}\n`));
});
