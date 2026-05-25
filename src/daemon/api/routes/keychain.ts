import { ShuttleError } from "../../../shared/errors.js";
import { getKeychainAdapter } from "../../../vault/keychain/index.js";
import { readEnvelope } from "../../../vault/envelope.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

export function registerKeychainRoutes(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/keychain/enable", async () => {
    const masterKey = services.lock.requireKey(); // throws vault_locked if not unlocked
    const envelope = await readEnvelope();
    if (envelope === null) {
      throw new ShuttleError(
        "envelope_missing",
        "No vault exists. Run `secret-shuttle init`.",
      );
    }
    const keychain = services.keychain ?? getKeychainAdapter();
    if (!(await keychain.isAvailable())) {
      throw new ShuttleError(
        "keychain_unavailable",
        "OS keychain is not available on this platform / environment.",
      );
    }
    await keychain.set("secret-shuttle", envelope.id, masterKey);
    return { enrolled: true };
  });

  server.addRoute("POST", "/v1/keychain/disable", async () => {
    const envelope = await readEnvelope();
    if (envelope === null) {
      // No vault at all — nothing to remove. Idempotent success.
      return { removed: true };
    }
    const keychain = services.keychain ?? getKeychainAdapter();
    if (!(await keychain.isAvailable())) {
      // No keychain → nothing to remove. Return success (idempotent semantics).
      return { removed: true };
    }
    await keychain.delete("secret-shuttle", envelope.id);
    return { removed: true };
  });

  server.addRoute("GET", "/v1/keychain/status", async () => {
    const envelope = await readEnvelope();
    const keychain = services.keychain ?? getKeychainAdapter();
    const available = await keychain.isAvailable();
    let enrolled = false;
    let vault_id: string | null = null;
    if (envelope !== null) {
      vault_id = envelope.id;
      if (available) {
        const entry = await keychain.get("secret-shuttle", envelope.id);
        enrolled = entry !== null;
      }
    }
    return { available, enrolled, vault_id };
  });
}
