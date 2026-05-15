import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { decryptEnvelope, encryptEnvelope, readEnvelope, writeEnvelope } from "../../../vault/envelope.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { openUrl } from "../../approvals/open-url.js";

const HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../approvals/unlock-ui.html",
);

export function registerUnlockSession(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/unlock/start", async () => {
    const envelope = await readEnvelope();
    const session = services.unlockSessions.create();
    // Open the UI window from the daemon process itself, so the CLI/agent never
    // sees the per-session ui_token.
    const url = `http://127.0.0.1:${daemonPortRef()}/ui/unlock?id=${session.id}&token=${session.ui_token}${envelope === null ? "&create=1" : ""}`;
    openUrl(url);
    return {
      session_id: session.id,
      requires_create: envelope === null,
      expires_at: session.expires_at,
    };
  });

  server.addRoute("POST", "/v1/unlock/poll", (_req, raw) => {
    const b = raw as { session_id?: string } | null;
    if (b === null || typeof b.session_id !== "string") throw new ShuttleError("bad_request", "session_id required.");
    const s = services.unlockSessions.get(b.session_id);
    if (s === undefined) throw new ShuttleError("unlock_session_not_found", "Unknown unlock session.");
    return { status: s.status, message: s.message ?? null };
  });

  server.addRouteRaw("GET", /^\/ui\/unlock$/, async (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await readFile(HTML_PATH, "utf8"));
  });

  server.addRouteRaw("POST", /^\/ui\/unlock\/[^/]+$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const m = url.pathname.match(/^\/ui\/unlock\/([^/]+)$/);
    if (m === null) throw new ShuttleError("bad_request", "Bad UI url.");
    const id = m[1] as string;
    const token = url.searchParams.get("token");
    const session = services.unlockSessions.get(id);
    if (session === undefined) throw new ShuttleError("unlock_session_not_found", "Unknown session.");
    if (session.ui_token !== token) throw new ShuttleError("ui_token_mismatch", "Invalid UI token.");

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const { passphrase, set_passphrase } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      passphrase: string;
      set_passphrase: boolean;
    };

    try {
      const existing = await readEnvelope();
      let masterKey: Buffer;
      if (existing === null) {
        if (set_passphrase !== true) throw new ShuttleError("envelope_missing", "No vault exists.");
        masterKey = randomBytes(32);
        await writeEnvelope(await encryptEnvelope(masterKey, passphrase));
      } else {
        masterKey = await decryptEnvelope(existing, passphrase);
      }
      services.lock.unlock(masterKey);
      await services.vault.ensureInitialized();
      session.status = "unlocked";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      session.status = "failed";
      session.message = err instanceof Error ? err.message : "failed";
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: { code: "vault_unlock_failed", message: session.message } }));
    }
  });
}
