import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { decryptEnvelope, encryptEnvelope, readEnvelope, writeEnvelope } from "../../../vault/envelope.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { getKeychainAdapter } from "../../../vault/keychain/index.js";

const HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../approvals/unlock-ui.html",
);

export function registerUnlockSession(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/unlock/start", async () => {
    const envelope = await readEnvelope();

    // Plan 5b/5f: try the OS keychain first. On macOS this fires Touch ID
    // synchronously. On Linux libsecret prompts (or silently returns null).
    // On Windows DPAPI unlocks transparently.
    //
    // The keychain is a cache — the passphrase remains the canonical recovery
    // credential. On any failure (no entry, cancelled, invalid cached key,
    // unavailable), fall through to the existing passphrase UI flow unchanged.
    if (envelope !== null) {
      const keychain = services.keychain ?? getKeychainAdapter();
      if (await keychain.isAvailable()) {
        const cached = await keychain.get("secret-shuttle", envelope.id);
        if (cached !== null) {
          try {
            services.lock.unlock(cached);
            await services.vault.ensureInitialized(); // throws vault_decryption_failed if key is wrong
            await writeDaemonAudit({ action: "unlock", ok: true, source: "keychain" });
            return { unlocked: true, source: "keychain" };
          } catch (err) {
            // Re-lock unconditionally so a partial unlock can't leak a bad key.
            services.lock.lock();
            // Determine whether this is an expected key-validation failure
            // (wrong cached key) or something unexpected (I/O error, audit
            // failure, etc.). Only the former should fall through silently.
            const isKeyValidationFailure =
              err instanceof ShuttleError &&
              (err.code === "vault_decryption_failed" || err.code === "invalid_master_key");
            await writeDaemonAudit({
              action: "unlock",
              ok: false,
              error_code: isKeyValidationFailure
                ? "keychain_key_invalid"
                : err instanceof ShuttleError
                  ? err.code
                  : "unexpected_error",
              source: "keychain",
            });
            if (!isKeyValidationFailure) {
              // Unexpected error — rethrow so the caller sees the real problem
              // instead of being silently routed to a passphrase UI that may
              // also fail with no forensic trail.
              throw err;
            }
            // Fall through to passphrase UI below.
          }
        }
      }
    }

    const session = services.unlockSessions.create();
    // Open the UI window from the daemon process itself, so the CLI/agent never
    // sees the per-session ui_token. Capture port once so the URL and the
    // broker's port arg can't diverge under a port-shift race.
    const port = daemonPortRef();
    const url = `http://127.0.0.1:${port}/ui/unlock?id=${session.id}&token=${session.ui_token}${envelope === null ? "&create=1" : ""}`;
    services.hubBroker.surface(url, port);
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
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
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
      await writeDaemonAudit({ action: "unlock", ok: true });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      session.status = "failed";
      session.message = err instanceof Error ? err.message : "failed";
      await writeDaemonAudit({
        action: "unlock",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
      });
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: { code: "vault_unlock_failed", message: session.message } }));
    }
  });
}
