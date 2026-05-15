import { ShuttleError } from "../shared/errors.js";
import { readSocketFile } from "../daemon/socket-file.js";

async function endpoint(): Promise<{ url: string; token: string }> {
  const sf = await readSocketFile();
  if (sf === null) {
    throw new ShuttleError("daemon_not_running", "Daemon not running. Run `secret-shuttle daemon start`.");
  }
  return { url: `http://127.0.0.1:${sf.port}`, token: sf.token };
}

export async function daemonRequest<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T & { ok: true }> {
  const { url, token } = await endpoint();
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`${url}${path}`, init);
  const text = await res.text();
  let payload: { ok: boolean; error?: { code: string; message: string } } & Record<string, unknown>;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ShuttleError("daemon_invalid_response", text);
  }
  if (!payload.ok) {
    const err = payload.error ?? { code: "unknown", message: "unknown error" };
    throw new ShuttleError(err.code, err.message);
  }
  return payload as T & { ok: true };
}
