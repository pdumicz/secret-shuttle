import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ShuttlePaths {
  homeDir: string;
  configPath: string;
  vaultPath: string;
  statePath: string;
  keyPath: string;
  envelopePath: string;
  daemonSocketPath: string;
  auditLogPath: string;
}

export function getSecretShuttleHome(): string {
  return process.env.SECRET_SHUTTLE_HOME ?? path.join(os.homedir(), ".secret-shuttle");
}

export function getShuttlePaths(homeDir = getSecretShuttleHome()): ShuttlePaths {
  return {
    homeDir,
    configPath: path.join(homeDir, "config.json"),
    vaultPath: path.join(homeDir, "vault.json.enc"),
    statePath: path.join(homeDir, "state.json"),
    keyPath: path.join(homeDir, "master-key.json"),
    envelopePath: path.join(homeDir, "key-envelope.json"),
    daemonSocketPath: path.join(homeDir, "daemon-socket.json"),
    auditLogPath: path.join(homeDir, "audit.jsonl"),
  };
}

export async function ensureShuttleHome(paths = getShuttlePaths()): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true });
  await chmod(paths.homeDir, 0o700).catch(() => undefined);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmpPath, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}
