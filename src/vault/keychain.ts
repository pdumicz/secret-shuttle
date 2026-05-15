import { chmod, readFile, writeFile } from "node:fs/promises";
import { ensureShuttleHome, fileExists, getShuttlePaths } from "../shared/config.js";
import { ShuttleError } from "../shared/errors.js";
import { createMasterKey, decodeKey, encodeKey } from "./crypto.js";
import type { MasterKeyFile } from "./types.js";

const LOCAL_FILE_WARNING =
  "V0 local-file key storage encrypts the vault at rest but is not a replacement for OS keychain-backed storage.";

export async function loadOrCreateMasterKey(): Promise<Buffer> {
  const envKey = process.env.SECRET_SHUTTLE_MASTER_KEY;
  if (envKey !== undefined && envKey.trim() !== "") {
    return decodeKey(envKey.trim());
  }

  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);

  if (await fileExists(paths.keyPath)) {
    const file = JSON.parse(await readFile(paths.keyPath, "utf8")) as MasterKeyFile;
    if (file.version !== 1 || file.storage !== "local-file") {
      throw new ShuttleError("unsupported_key_storage", "Unsupported Secret Shuttle master key format.");
    }
    return decodeKey(file.key);
  }

  const key = createMasterKey();
  const keyFile: MasterKeyFile = {
    version: 1,
    algorithm: "aes-256-gcm",
    key: encodeKey(key),
    storage: "local-file",
    warning: LOCAL_FILE_WARNING,
  };

  await writeFile(paths.keyPath, `${JSON.stringify(keyFile, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(paths.keyPath, 0o600).catch(() => undefined);
  return key;
}

export async function hasLegacyKeyFile(): Promise<boolean> {
  return fileExists(getShuttlePaths().keyPath);
}

export async function readLegacyKey(): Promise<Buffer | null> {
  const paths = getShuttlePaths();
  if (!(await fileExists(paths.keyPath))) return null;
  const file = JSON.parse(await readFile(paths.keyPath, "utf8")) as MasterKeyFile;
  if (file.version !== 1 || file.storage !== "local-file") {
    throw new ShuttleError("unsupported_key_storage", "Unsupported legacy key format.");
  }
  return decodeKey(file.key);
}
