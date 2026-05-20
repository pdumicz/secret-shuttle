import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeDaemonAudit } from "../audit.js";

export interface SweepTmpDirInput {
  /** The daemon-owned tmp dir (e.g. ~/.secret-shuttle/tmp/). */
  tmpDir: string;
  /** If true, every regular file is deleted regardless of age (startup mode). */
  force?: boolean;
  /** Periodic-mode bound; files with mtimeMs < (now - maxAgeMs) are deleted. */
  maxAgeMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Best-effort: removes every regular file in `tmpDir` that matches the criteria.
 * Never throws — a missing tmpDir is a no-op; a failing unlink is logged-and-
 * skipped. Used in two modes:
 *
 *   - Startup (force:true): everything goes. Anything still here is from a
 *     prior daemon run that ended abnormally (SIGKILL/OOM/host crash) past
 *     runTemplate's `finally`. The 0600 file + 0700 dir already bounded the
 *     exposure to the daemon user; this completes the cleanup.
 *
 *   - Periodic (maxAgeMs): files older than the bound go. The 30s interval +
 *     60s age bound (see main.ts) caps worst-case exposure to ~90s in a 0600
 *     file in a 0700 dir even if a child hangs past the per-run finally.
 *
 * Subdirectories are deliberately left alone (the sweep operates on the secret-
 * bearing env-files only; the tmp dir holds nothing else by design).
 */
export async function sweepTmpDir(input: SweepTmpDirInput): Promise<void> {
  const now = (input.now ?? Date.now)();
  let entries: string[];
  try {
    entries = readdirSync(input.tmpDir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    return; // unreadable dir → best-effort no-op
  }
  for (const entry of entries) {
    const fullPath = path.join(input.tmpDir, entry);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (input.force !== true) {
      const maxAge = input.maxAgeMs ?? 60_000;
      if (now - st.mtimeMs < maxAge) continue;
    }
    let ok = true;
    try {
      unlinkSync(fullPath);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") ok = false;
    }
    await writeDaemonAudit({
      action: "template_tmp_sweep",
      ok,
      message: fullPath,
    });
  }
}
