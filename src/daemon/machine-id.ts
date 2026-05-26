import { randomBytes } from "node:crypto";
import { readFile, writeFile, stat, unlink, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";

const MACHINE_ID_FILE = "machine-id";

function assertValidContent(s: string, file: string): void {
  // 32 random bytes base64url-encoded with no padding is exactly 43 chars.
  if (s.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new ShuttleError(
      "machine_id_malformed",
      `machine_id_malformed: ${file} content is not a 43-char base64url-no-pad string.`,
    );
  }
  // Sanity check: decoded length must be 32 bytes.
  if (Buffer.from(s, "base64url").byteLength !== 32) {
    throw new ShuttleError(
      "machine_id_malformed",
      `machine_id_malformed: ${file} decodes to wrong length; expected 32 bytes.`,
    );
  }
}

export async function readMachineId(shuttleHome: string): Promise<string | null> {
  try {
    const buf = (await readFile(path.join(shuttleHome, MACHINE_ID_FILE), "utf8")).trim();
    assertValidContent(buf, path.join(shuttleHome, MACHINE_ID_FILE));
    return buf;
  } catch (e) {
    if (e instanceof ShuttleError) throw e;
    return null;
  }
}

export async function ensureMachineId(shuttleHome: string): Promise<string> {
  const file = path.join(shuttleHome, MACHINE_ID_FILE);
  try {
    const st = await stat(file);
    if ((st.mode & 0o777) !== 0o600) {
      throw new ShuttleError(
        "machine_id_bad_mode",
        `machine_id_bad_mode: ${file} is mode ${(st.mode & 0o777).toString(8)}, expected 0600`,
      );
    }
    const content = (await readFile(file, "utf8")).trim();
    assertValidContent(content, file);
    return content;
  } catch (e) {
    if (e instanceof ShuttleError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await mkdir(shuttleHome, { recursive: true });
  const id = randomBytes(32).toString("base64url");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, id, { mode: 0o600 });
  await rename(tmp, file);
  return id;
}

export async function resetMachineId(shuttleHome: string): Promise<void> {
  try {
    await unlink(path.join(shuttleHome, MACHINE_ID_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
