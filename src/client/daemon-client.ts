import { ShuttleError } from "../shared/errors.js";
import { readSocketFile } from "../daemon/socket-file.js";

async function endpoint(): Promise<{ url: string; token: string }> {
  const sf = await readSocketFile();
  if (sf === null) {
    throw new ShuttleError("daemon_not_running", "Daemon not running. Run `secret-shuttle daemon start`.");
  }
  return { url: `http://127.0.0.1:${sf.port}`, token: sf.token };
}

/**
 * Reconstruct a ShuttleError from a daemon JSON payload, preserving daemon-
 * provided hint and exit_code if present. Falls back to registry defaults
 * when the daemon emits the legacy shape only.
 *
 * Tolerant of both shapes:
 *  - Nested legacy: `{ error: { code, message } }`
 *  - Flat agent-friendly: `{ error_code, message }` (no nested error block)
 *  - Both (the canonical new contract)
 * If both are present, the nested block wins for code/message (it's the
 * source of truth in the documented contract).
 */
export function daemonErrorFromPayload(payload: unknown): ShuttleError {
  const p = (payload ?? {}) as Record<string, unknown>;
  const errBlock = (p.error ?? {}) as { code?: string; message?: string };

  // code: prefer nested, fall back to flat, then "unknown"
  const code =
    (typeof errBlock.code === "string" ? errBlock.code : undefined) ??
    (typeof p.error_code === "string" ? p.error_code : undefined) ??
    "unknown";
  // message: prefer nested, fall back to flat, then "unknown error"
  const message =
    (typeof errBlock.message === "string" ? errBlock.message : undefined) ??
    (typeof p.message === "string" ? p.message : undefined) ??
    "unknown error";

  // Daemon-provided fields take precedence over registry defaults.
  const opts: { exitCode?: number; hint?: string | null } = {};
  if (typeof p.exit_code === "number") opts.exitCode = p.exit_code;
  if (typeof p.hint === "string" || p.hint === null) opts.hint = p.hint;

  return new ShuttleError(code, message, opts);
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
  let payload: { ok: boolean } & Record<string, unknown>;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ShuttleError("daemon_invalid_response", text);
  }
  if (!payload.ok) {
    throw daemonErrorFromPayload(payload);
  }
  return payload as T & { ok: true };
}
