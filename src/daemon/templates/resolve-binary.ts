import { access, constants } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";

export async function resolveBinary(binary: string): Promise<string> {
  if (path.isAbsolute(binary)) return binary;
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (dir === "") continue;
    const candidate = path.join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new ShuttleError("unsafe_binary_path", `Could not resolve binary on PATH: ${binary}`);
}
