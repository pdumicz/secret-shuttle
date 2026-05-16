import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";

export interface SafeExecutableOptions {
  /** If set, the resolved file's SHA-256 must equal this (lowercase hex). */
  expectedSha256?: string;
}

/**
 * Validate that `binary` is safe for the daemon to execute as part of the
 * secret plane. Returns the realpath-resolved absolute path.
 *
 * Rejects: relative paths, symlink targets that fail the same checks, paths
 * under the current workspace, non-regular files, world-writable files, and
 * (when pinned) a SHA-256 mismatch.
 */
export async function assertSafeExecutable(
  binary: string,
  opts: SafeExecutableOptions = {},
): Promise<string> {
  if (!path.isAbsolute(binary)) {
    throw new ShuttleError("unsafe_binary_path", "Executable path must be absolute.");
  }
  let resolved: string;
  try {
    resolved = await realpath(binary);
  } catch {
    throw new ShuttleError("unsafe_binary_path", "Executable not found.");
  }
  const cwd = path.resolve(process.cwd());
  if (resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)) {
    throw new ShuttleError("unsafe_binary_path", "Executable must not live under the current workspace.");
  }
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new ShuttleError("unsafe_binary_path", "Executable not found.");
  }
  if (!info.isFile()) {
    throw new ShuttleError("unsafe_binary_path", "Executable is not a regular file.");
  }
  if ((info.mode & 0o002) !== 0) {
    throw new ShuttleError("unsafe_binary_path", "Executable is world-writable.");
  }
  if (opts.expectedSha256 !== undefined) {
    const actual = createHash("sha256").update(await readFile(resolved)).digest("hex");
    if (actual !== opts.expectedSha256.toLowerCase()) {
      throw new ShuttleError("binary_hash_mismatch", "Executable SHA-256 does not match the pinned value.");
    }
  }
  return resolved;
}
