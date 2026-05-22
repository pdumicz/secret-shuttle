import { readSocketFile } from "../daemon/socket-file.js";
import { ShuttleError } from "../shared/errors.js";
import { daemonErrorFromPayload } from "./daemon-client.js";

export type StreamLine = (
  | { stream: "stdout"; data: string } // base64
  | { stream: "stderr"; data: string } // base64
  | { exit: number }
  | { error: { code: string; message: string; hint?: string | null; exit_code?: number } }
) & Record<string, unknown>;

/**
 * Read a ReadableStream<Uint8Array> as a sequence of newline-terminated JSON
 * messages and invoke `onLine` for each one. Buffers across chunk boundaries.
 * Throws if any line is not valid JSON.
 */
export async function streamLineDelimitedJson(
  body: ReadableStream<Uint8Array>,
  onLine: (line: StreamLine) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nlIdx = buffer.indexOf("\n");
        if (nlIdx === -1) break;
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        if (line.trim().length === 0) continue;
        let parsed: StreamLine;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(`invalid JSON line from daemon stream: ${line.slice(0, 200)}`);
        }
        onLine(parsed);
      }
    }
    // Flush any trailing line (no terminating newline)
    if (buffer.trim().length > 0) {
      try {
        onLine(JSON.parse(buffer));
      } catch {
        throw new Error(`invalid JSON line from daemon stream: ${buffer.slice(0, 200)}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Open a streaming POST to the daemon. Throws daemon_not_running if no socket.
 * Returns the ReadableStream<Uint8Array> of the response body for the caller
 * to feed into streamLineDelimitedJson().
 *
 * Cancellation: pass an AbortSignal to interrupt the fetch (the CLI uses this
 * to forward SIGINT/SIGTERM into a closed-socket → daemon res.on('close') →
 * SIGTERM-the-child chain).
 */
export async function streamingDaemonRequest(
  method: "POST",
  path: string,
  body: unknown,
  options?: { signal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> {
  const sf = await readSocketFile();
  if (sf === null) {
    throw new ShuttleError("daemon_not_running", "Daemon not running. Run `secret-shuttle daemon start`.");
  }
  const res = await fetch(`http://127.0.0.1:${sf.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${sf.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (res.body === null) {
    throw new ShuttleError("daemon_invalid_response", "Daemon returned no response body for streaming endpoint.");
  }
  if (!res.ok) {
    // Non-200 — reconstruct via the canonical Plan-1 helper so daemon-provided
    // `hint` and `exit_code` survive (which a manual `new ShuttleError(code, msg)`
    // would silently drop, regressing the contract from src/client/daemon-client.ts).
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ShuttleError("daemon_invalid_response", text);
    }
    throw daemonErrorFromPayload(parsed);
  }
  return res.body;
}
