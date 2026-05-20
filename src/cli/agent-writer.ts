import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../shared/errors.js";

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

/** Escape regex metacharacters in a marker string. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count line-anchored occurrences of `marker` in `content`. */
function countLineAnchored(content: string, marker: string): number {
  const re = new RegExp(`^${escapeRe(marker)}$`, "gm");
  return (content.match(re) ?? []).length;
}

/**
 * Locate the indices of a line-anchored marker pair. Returns null if either
 * marker appears zero times OR appears more than once (the caller checks
 * count > 1 separately and fails closed; this helper just returns the
 * unambiguous-pair indices or null).
 */
function findLineAnchoredPair(
  content: string,
  beginMarker: string,
  endMarker: string,
): { beginIdx: number; endIdx: number } | null {
  const beginRe = new RegExp(`(^|\\n)${escapeRe(beginMarker)}(?=\\n|$)`, "g");
  const endRe = new RegExp(`(^|\\n)${escapeRe(endMarker)}(?=\\n|$)`, "g");
  const bm = beginRe.exec(content);
  const em = endRe.exec(content);
  if (bm === null || em === null) return null;
  // Compute the byte offsets of the marker itself (skip the leading `\n` if any)
  const beginIdx = bm.index + (bm[1] === "\n" ? 1 : 0);
  const endIdx = em.index + (em[1] === "\n" ? 1 : 0);
  return { beginIdx, endIdx };
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
 *   - File has BOTH markers on their own lines (line-anchored) → replace the
 *     byte range from `begin` line through `end` line (inclusive) with the new
 *     marked block; every other byte preserved. Markers that appear inline
 *     within a line (e.g. copy-pasted README examples) are ignored.
 *   - File lacks one or both line-anchored markers → append two leading
 *     newlines + new marked block at end-of-file. The pre-existing bytes
 *     (including any orphan marker half) are preserved — we never attempt repair.
 *   - File has more than one line-anchored begin OR end marker → throws
 *     ShuttleError("snippet_ambiguous", ...). Fail-closed: no bytes written.
 *     The user must repair the file manually before re-running.
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
  // Sanitize: refuse to write if the target has ambiguous markers (multiple
  // begin or end markers on their own lines). The user must repair manually.
  if (existing !== null) {
    const beginCount = countLineAnchored(existing, opts.beginMarker);
    const endCount = countLineAnchored(existing, opts.endMarker);
    if (beginCount > 1 || endCount > 1) {
      throw new ShuttleError(
        "snippet_ambiguous",
        `Target ${opts.targetPath} has multiple secret-shuttle markers (begin=${beginCount}, end=${endCount}) — repair manually before re-running.`,
      );
    }
  }
  let out: string;
  if (existing === null) {
    out = newBlock;
  } else {
    const pair = findLineAnchoredPair(existing, opts.beginMarker, opts.endMarker);
    if (pair !== null && pair.endIdx > pair.beginIdx) {
      const afterEnd = pair.endIdx + opts.endMarker.length;
      const trailingNl = existing[afterEnd] === "\n" ? 1 : 0;
      const before = existing.slice(0, pair.beginIdx);
      const after = existing.slice(afterEnd + trailingNl);
      out = before + newBlock + after;
    } else {
      // Markers missing OR orphaned half — append at end with a visual gap.
      // Pre-existing bytes (including any orphan marker half) are preserved.
      const sep = "\n\n";
      out = existing + (existing.endsWith("\n") ? "" : "\n") + sep + newBlock;
    }
  }
  const tmpPath = `${opts.targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, out, { mode: 0o644 });
  await rename(tmpPath, opts.targetPath);
}
