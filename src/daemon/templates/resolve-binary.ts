import { access, constants, realpath } from "node:fs/promises";
import path from "node:path";
import { ShuttleError } from "../../shared/errors.js";

const SAFE_DIRS =
  process.platform === "darwin"
    ? ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : process.platform === "win32"
      ? [
          "C:\\Windows\\System32",
          "C:\\Windows",
          "C:\\Program Files\\Vercel CLI",
        ]
      : ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

export async function resolveBinary(binary: string): Promise<string> {
  if (path.isAbsolute(binary)) {
    return realpath(binary);
  }
  for (const dir of SAFE_DIRS) {
    const candidate = path.join(dir, binary);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {}
  }
  throw new ShuttleError(
    "unsafe_binary_path",
    `Binary ${binary} not found in approved system directories.`,
  );
}
