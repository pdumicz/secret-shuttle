import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface WriteAgentFileOpts {
  targetPath: string;
  content: string;
}

/**
 * Wholesale overwrite. The target is Secret-Shuttle-owned (e.g.
 * .claude/skills/secret-shuttle/SKILL.md, .cursor/rules/secret-shuttle.mdc).
 * Atomic via temp + rename. mkdir -p the parent.
 * File mode 0644 (world-readable; this is a normal config file).
 */
export async function writeAgentFile(opts: WriteAgentFileOpts): Promise<void> {
  await mkdir(path.dirname(opts.targetPath), { recursive: true });
  const tmpPath = `${opts.targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, opts.content, { mode: 0o644 });
  await rename(tmpPath, opts.targetPath);
}

export interface WriteAgentSnippetOpts {
  targetPath: string;
  content: string;
  beginMarker: string;
  endMarker: string;
}

/**
 * Idempotent marker-based snippet writer. Target is user-owned but contains
 * one block managed by Secret Shuttle, delimited by beginMarker..endMarker
 * (HTML/Markdown comments).
 *
 *   - File missing → create with `${begin}\n${content}\n${end}\n`.
 *   - File has BOTH markers → replace the byte range from `begin` line through
 *     `end` line (inclusive) with the new marked block; every other byte
 *     preserved.
 *   - File lacks one or both markers → append two leading newlines + new
 *     marked block at end-of-file. The pre-existing bytes (including any
 *     orphan marker half) are preserved — we never attempt repair.
 *
 * Atomic via temp + rename.
 */
export async function writeAgentSnippet(opts: WriteAgentSnippetOpts): Promise<void> {
  await mkdir(path.dirname(opts.targetPath), { recursive: true });
  const newBlock = `${opts.beginMarker}\n${opts.content}${opts.content.endsWith("\n") ? "" : "\n"}${opts.endMarker}\n`;
  let existing: string | null = null;
  try {
    existing = await readFile(opts.targetPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    existing = null;
  }
  let out: string;
  if (existing === null) {
    out = newBlock;
  } else {
    const beginIdx = existing.indexOf(opts.beginMarker);
    const endIdx = existing.indexOf(opts.endMarker);
    if (beginIdx >= 0 && endIdx > beginIdx) {
      const afterEnd = endIdx + opts.endMarker.length;
      const trailingNl = existing[afterEnd] === "\n" ? 1 : 0;
      const before = existing.slice(0, beginIdx);
      const after = existing.slice(afterEnd + trailingNl);
      out = before + newBlock + after;
    } else {
      const sep = existing.endsWith("\n") ? "\n\n" : "\n\n";
      out = existing + sep + newBlock;
    }
  }
  const tmpPath = `${opts.targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, out, { mode: 0o644 });
  await rename(tmpPath, opts.targetPath);
}
