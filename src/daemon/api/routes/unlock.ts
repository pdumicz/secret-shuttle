// src/daemon/api/routes/unlock.ts
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { isInsecureDevMode } from "../../../shared/secure-mode.js";
import { decryptEnvelope, encryptEnvelope, readEnvelope, writeEnvelope } from "../../../vault/envelope.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";

function requireInsecureDevMode(): void {
  if (!isInsecureDevMode()) {
    throw new ShuttleError(
      "removed_in_secure_mode",
      "Direct passphrase unlock is disabled in Secure Mode. Use `secret-shuttle unlock` (web UI).",
    );
  }
}

interface UnlockBody {
  passphrase: string;
  set_passphrase?: boolean;
}

export function registerUnlock(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/unlock", async (_req, raw) => {
    try {
      requireInsecureDevMode();
      const body = raw as UnlockBody | null;
      if (body === null || typeof body.passphrase !== "string" || body.passphrase === "") {
        throw new ShuttleError("invalid_passphrase", "passphrase is required");
      }

      const existing = await readEnvelope();
      if (existing === null) {
        if (body.set_passphrase !== true) {
          throw new ShuttleError(
            "envelope_missing",
            "No vault exists yet. Call unlock with set_passphrase=true to create one.",
          );
        }
        const masterKey = randomBytes(32);
        const envelope = await encryptEnvelope(masterKey, body.passphrase);
        await writeEnvelope(envelope);
        services.lock.unlock(masterKey);
        await services.vault.ensureInitialized();
        await writeDaemonAudit({ action: "unlock", ok: true });
        return { unlocked: true, created: true };
      }

      const masterKey = await decryptEnvelope(existing, body.passphrase);
      services.lock.unlock(masterKey);
      await services.vault.ensureInitialized();
      await writeDaemonAudit({ action: "unlock", ok: true });
      return { unlocked: true, created: false };
    } catch (err) {
      await writeDaemonAudit({
        action: "unlock",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
      });
      throw err;
    }
  });

  server.addRoute("POST", "/v1/lock", async () => {
    try {
      requireInsecureDevMode();
      services.lock.lock();
      await writeDaemonAudit({ action: "lock", ok: true });
      return { unlocked: false };
    } catch (err) {
      await writeDaemonAudit({
        action: "lock",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
      });
      throw err;
    }
  });
}
