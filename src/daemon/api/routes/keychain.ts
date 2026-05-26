import { ShuttleError } from "../../../shared/errors.js";
import { getKeychainAdapter } from "../../../vault/keychain/index.js";
import { readEnvelope, writeEnvelope, type EnvelopeFile } from "../../../vault/envelope.js";
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
    // Clear any prior opt-out so future unlocks resume keychain caching.
    if (envelope.keychain_opt_out === true) {
      const updated: EnvelopeFile = { ...envelope, keychain_opt_out: false };
      await writeEnvelope(updated);
    }
    return { ok: true, enrolled: true };
  });

  server.addRoute("POST", "/v1/keychain/disable", async () => {
    const envelope = await readEnvelope();
    if (envelope === null) {
      // No vault at all — nothing to remove. Idempotent success.
      return { ok: true, removed: true };
    }
    // Persist the opt-out BEFORE deleting so a crash between the two steps
    // doesn't leave the user with a still-enrolled, but-supposed-to-be-disabled state.
    if (envelope.keychain_opt_out !== true) {
      const updated: EnvelopeFile = { ...envelope, keychain_opt_out: true };
      await writeEnvelope(updated);
    }
    const keychain = services.keychain ?? getKeychainAdapter();
    if (await keychain.isAvailable()) {
      await keychain.delete("secret-shuttle", envelope.id);
    }
    return { ok: true, removed: true };
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
        // Use hasEntry for a passive existence check — never retrieves the
        // master key into daemon memory and never triggers OS UI (Touch ID,
        // libsecret prompt). On Windows, DPAPI is transparent so get() is safe,
        // but hasEntry delegates to the same call and discards the value.
        enrolled = await keychain.hasEntry("secret-shuttle", envelope.id);
      }
    }
    return { available, enrolled, vault_id };
  });
}
