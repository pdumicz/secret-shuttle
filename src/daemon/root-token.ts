import { randomBytes } from "node:crypto";
import { readFile, writeFile, stat, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";

const ROOT_TOKEN_FILE = "root-token";

function assertValidContent(s: string, file: string): void {
  if (s.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new ShuttleError(
      "root_token_malformed",
      `${file} content is not a 43-char base64url-no-pad string.`,
    );
  }
  if (Buffer.from(s, "base64url").byteLength !== 32) {
    throw new ShuttleError(
      "root_token_malformed",
      `${file} decodes to wrong length; expected 32 bytes.`,
    );
  }
}

export async function ensureRootToken(shuttleHome: string): Promise<string> {
  const file = path.join(shuttleHome, ROOT_TOKEN_FILE);
  try {
    const st = await stat(file);
    if ((st.mode & 0o777) !== 0o600) {
      throw new ShuttleError(
        "root_token_bad_mode",
        `${file} is mode ${(st.mode & 0o777).toString(8)}, expected 0600`,
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
  const t = randomBytes(32).toString("base64url");
  const tmp = `${file}.tmp`;
  await writeFile(tmp, t, { mode: 0o600 });
  await rename(tmp, file);
  return t;
}

export async function rotateRootToken(shuttleHome: string): Promise<string> {
  const file = path.join(shuttleHome, ROOT_TOKEN_FILE);
  await mkdir(shuttleHome, { recursive: true });
  const t = randomBytes(32).toString("base64url");
  // Per-call random suffix so the temp path is unique. The route-level
  // mutex in daemon-admin.ts already serializes /v1/daemon/rotate, but
  // this is defense-in-depth: if anything else writes the legacy fixed
  // `root-token.tmp` (a stale crash-recovery artifact, a test, etc.),
  // the in-flight rotate won't collide on the same path.
  const tmp = `${file}.tmp.${randomBytes(8).toString("hex")}`;
  await writeFile(tmp, t, { mode: 0o600 });
  await rename(tmp, file);
  return t;
}
