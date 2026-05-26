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
 * Linux libsecret adapter via @napi-rs/keyring AsyncEntry.
 *
 * Uses the Secret Service API (gnome-keyring, KDE Wallet, KeePassXC, etc.).
 * Falls back to isAvailable: false if libsecret is missing (e.g., minimal
 * containers without a desktop session).
 *
 * isAvailable() probes for libsecret reachability by attempting a no-op
 * read — this catches the "library loaded but D-Bus session unavailable"
 * case that container-based dev environments commonly hit.
 */
export class LinuxKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    const E = await loadKeyring();
    if (E === null) return false;
    // libsecret may be installed but unreachable (no D-Bus session).
    // Probe with a read of a guaranteed-empty entry — should not throw.
    try {
      const entry = new E("secret-shuttle-probe", "isAvailable");
      await entry.getPassword();
      return true;
    } catch {
      return false;
    }
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
      throw new ShuttleError(
        "keychain_unavailable",
        `Keychain delete failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

}
