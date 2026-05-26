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
    // P2 post-ship fix: write a non-secret marker entry alongside the real key.
    // Status checks read this marker instead of calling hasEntry (which in some
    // adapter implementations materializes ALL passwords under the service into
    // JS memory via findCredentialsAsync). The marker value is non-sensitive —
    // knowing a vault is enrolled on this machine enables no attack.
    await keychain.set("secret-shuttle", `${envelope.id}:enrolled`, Buffer.from("enrolled"));
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
      // P2: also delete the non-secret marker written by enable/C2.
      await keychain.delete("secret-shuttle", `${envelope.id}:enrolled`);
    }
    return { ok: true, removed: true };
  });

  server.addRoute("GET", "/v1/keychain/status", async () => {
    const envelope = await readEnvelope();
    const keychain = services.keychain ?? getKeychainAdapter();
    const available = await keychain.isAvailable();
    let enrolled = false;
    let opted_out = false;
    let vault_id: string | null = null;
    if (envelope !== null) {
      vault_id = envelope.id;
      opted_out = envelope.keychain_opt_out === true;
      if (available && !opted_out) {
        // P2 post-ship fix: read the non-secret marker entry instead of calling
        // hasEntry(). Some adapter implementations of hasEntry() used
        // findCredentialsAsync() which materializes ALL passwords under the
        // "secret-shuttle" service into JS memory just to test existence.
        //
        // The marker entry (account = "<id>:enrolled", value = "enrolled") is
        // non-sensitive by design: it reveals only that this vault is enrolled.
        // The real master key entry's bytes never enter daemon memory for a
        // status query.
        //
        // P2.2 fix: when opted_out is true, skip the marker check entirely.
        // A stale marker left by a crash must not report enrolled: true when
        // the user has opted out. enrolled stays false in that case.
        const marker = await keychain.get("secret-shuttle", `${envelope.id}:enrolled`);
        enrolled = marker !== null;
      }
    }
    return { available, enrolled, opted_out, vault_id };
  });
}
