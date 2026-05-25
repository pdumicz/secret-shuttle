import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

// Dynamic import so the module can be loaded on platforms where @napi-rs/keyring
// fails (we want isAvailable() to return false rather than module-load throwing).
let KeyringEntry: typeof import("@napi-rs/keyring").AsyncEntry | null = null;
let loadAttempted = false;

async function loadKeyring(): Promise<typeof import("@napi-rs/keyring").AsyncEntry | null> {
  if (loadAttempted) return KeyringEntry;
  loadAttempted = true;
  try {
    const mod = await import("@napi-rs/keyring");
    KeyringEntry = mod.AsyncEntry;
    return KeyringEntry;
  } catch {
    return null;
  }
}

/**
 * macOS Keychain Services adapter via @napi-rs/keyring.
 *
 * Keychain access triggers Touch ID / passphrase prompts at the OS layer —
 * the OS UX is the credential check, this adapter just shuttles the bytes.
 *
 * Values are stored base64-encoded (Keychain stores strings; we want Buffers).
 *
 * All methods use AsyncEntry so Keychain calls never block the Node.js event
 * loop. The sync Entry class returns values directly — the `await` on its
 * methods was a no-op.
 */
export class DarwinKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    const E = await loadKeyring();
    return E !== null;
  }

  async set(service: string, account: string, secret: Buffer): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      await entry.setPassword(secret.toString("base64"));
    } catch (e) {
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain set failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async get(service: string, account: string): Promise<Buffer | null> {
    const E = await loadKeyring();
    if (E === null) return null;
    try {
      const entry = new E(service, account);
      const v = await entry.getPassword();
      if (v === null || v === undefined) return null;
      return Buffer.from(v, "base64");
    } catch {
      // Touch ID cancelled, no entry, permission denied → null.
      // The caller treats null as "fall through to passphrase UI".
      return null;
    }
  }

  async delete(service: string, account: string): Promise<void> {
    const E = await loadKeyring();
    if (E === null) {
      throw new ShuttleError("keychain_unavailable", "Keychain native module not loaded.");
    }
    try {
      const entry = new E(service, account);
      // deleteCredential returns a boolean (true = deleted, false = not found).
      // Either outcome is success for an idempotent delete — no error-message
      // matching needed, which avoids cross-platform regex fragility.
      await entry.deleteCredential();
    } catch (e) {
      // Only genuine OS errors (permission denied, daemon unavailable, etc.)
      // reach here; "not found" is handled by deleteCredential returning false.
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
