/**
 * Burst 7 §1 (Plan 5s) — opt-in per-project agent identity config.
 *
 * `identity.perProject: true` in secret-shuttle.config.json (the same file
 * Burst 6 introduced `infer.supabaseNames` into) opts a project into the
 * per-project agent-id derivation. The loader mirrors loadInferConfig's
 * defensive pattern (infer.ts): missing file / malformed JSON / non-object /
 * missing `identity` / non-boolean `perProject` all → false. The writer MERGES
 * the key into an existing config, preserving every other key (notably
 * `infer.*`) so the `init --per-project-identity` flag never clobbers it.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_FILE = "secret-shuttle.config.json";

export async function loadIdentityPerProject(cwd: string): Promise<boolean> {
  try {
    const raw = await readFile(join(cwd, CONFIG_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const identity = (parsed as Record<string, unknown>)["identity"];
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
      return false;
    }
    const perProject = (identity as Record<string, unknown>)["perProject"];
    return perProject === true;
  } catch {
    return false;
  }
}

/**
 * Merge `identity.perProject = true` into secret-shuttle.config.json. Creates
 * the file when absent. Preserves all other top-level keys and all sibling
 * keys under `identity`. A malformed/non-object existing file is replaced with
 * a fresh minimal config (the loader already treats malformed as opt-out, so
 * overwriting it with the explicit opt-in the user just asked for is correct).
 */
export async function writePerProjectIdentity(cwd: string): Promise<void> {
  const path = join(cwd, CONFIG_FILE);
  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed → start from {} (preserves nothing because there
    // was nothing valid to preserve).
  }
  const existingIdentity = root["identity"];
  const identity: Record<string, unknown> =
    existingIdentity !== null && typeof existingIdentity === "object" && !Array.isArray(existingIdentity)
      ? { ...(existingIdentity as Record<string, unknown>) }
      : {};
  identity["perProject"] = true;
  root["identity"] = identity;
  // Atomic write (temp-file + rename) mirroring machine-id.ts / root-token.ts:
  // a crash mid-write must never truncate a user-editable config we re-read on
  // every `init`. rename(2) is atomic within a filesystem.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
