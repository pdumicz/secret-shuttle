import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { ensureShuttleHome, fileExists, getShuttlePaths } from "../shared/config.js";

export interface SocketFile {
  port: number;
  token: string;
  pid: number;
}

export async function writeSocketFile(value: SocketFile): Promise<void> {
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  await writeFile(paths.daemonSocketPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(paths.daemonSocketPath, 0o600).catch(() => undefined);
}

export async function readSocketFile(): Promise<SocketFile | null> {
  const paths = getShuttlePaths();
  if (!(await fileExists(paths.daemonSocketPath))) return null;
  const raw = await readFile(paths.daemonSocketPath, "utf8");
  return JSON.parse(raw) as SocketFile;
}

export async function removeSocketFile(): Promise<void> {
  const paths = getShuttlePaths();
  await rm(paths.daemonSocketPath, { force: true });
}
