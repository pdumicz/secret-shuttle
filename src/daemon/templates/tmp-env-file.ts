import { closeSync, openSync, statSync, unlinkSync, writeSync, constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";

export interface WriteSecretEnvFileInput {
  /** Env-var name (e.g. "STRIPE_SECRET_KEY"). Must not contain '=' or newline. */
  name: string;
  /** The secret value. Held in a local Buffer that is zeroed after write. */
  value: string;
  /** Daemon-owned tmp dir (mode 0700) — see services.tmpDir. */
  tmpDir: string;
}

export interface WriteSecretEnvFileResult {
  path: string;
}

/**
 * Atomically creates a 0600 file at `<tmpDir>/<random>.env` containing exactly
 * "NAME=VALUE\n", using O_CREAT|O_EXCL|O_WRONLY so a pre-existing path is a hard
 * fail. The secret value is held in a single Buffer for the duration of the
 * write, then zeroed before the function returns.
 *
 * Security:
 * - Mode 0600 is set at file-creation time (third arg to openSync), NOT via a
 *   subsequent chmod, so there is no window where the file is world-readable.
 * - O_EXCL refuses an existing path (defense against a pre-planted symlink or
 *   race-created file in the daemon-owned tmp dir).
 * - The function never reads or holds the value after the write; the returned
 *   shape exposes only the path.
 */
export function writeSecretEnvFile(input: WriteSecretEnvFileInput): WriteSecretEnvFileResult {
  if (input.name.length === 0 || /[=\n\r\0]/.test(input.name)) {
    throw new ShuttleError(
      "invalid_env_var_name",
      "Env-file NAME must be non-empty and contain no '=', newline, or NUL.",
    );
  }
  const filePath = path.join(input.tmpDir, `${randomBytes(16).toString("hex")}.env`);
  return writeSecretEnvFileAt({ name: input.name, value: input.value, path: filePath });
}

/**
 * Test-internal variant that writes to a fixed path. Production code calls
 * writeSecretEnvFile, which generates a random path.
 */
export function writeSecretEnvFileAt(input: { name: string; value: string; path: string }): WriteSecretEnvFileResult {
  const buf = Buffer.from(`${input.name}=${input.value}\n`, "utf8");
  let fd: number;
  try {
    fd = openSync(
      input.path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
  } catch (err) {
    buf.fill(0);
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      throw new ShuttleError(
        "template_env_file_collision",
        "Env-file path already exists (refusing to overwrite).",
      );
    }
    throw new ShuttleError(
      "template_env_file_write_failed",
      `Failed to create env-file: ${(err as Error).message}`,
    );
  }
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
    buf.fill(0);
  }
  return { path: input.path };
}

/**
 * Deletes the file. ENOENT-tolerant (the file may already have been swept by
 * the periodic sweep, or may have been removed by an external operator).
 * Every other error is silently swallowed by design — the caller is in a
 * finally block on the no-leak path; throwing would mask the original error.
 */
export function unlinkSecretEnvFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    // Any other unlink failure is non-fatal at this layer; the periodic sweep
    // will pick it up.
  }
}

/**
 * Defensive: returns true iff the path lives at mode 0600 right now. Used in
 * tests; not called by runTemplate (which trusts O_CREAT|O_EXCL + mode 0600).
 */
export function isMode0600(filePath: string): boolean {
  try {
    return (statSync(filePath).mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}
