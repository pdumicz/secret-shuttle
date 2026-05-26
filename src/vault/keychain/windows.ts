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
 * Windows Credential Manager (DPAPI) adapter via @napi-rs/keyring AsyncEntry.
 *
 * Uses Windows Credential Manager. Transparent unlock when the user is
 * logged in (no extra prompt). Encryption is DPAPI-bound to the user
 * account; entries cannot be read by other users on the same machine.
 */
export class WindowsKeychain implements KeychainAdapter {
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

  /**
   * Passive existence check. Windows DPAPI unlock is transparent (no UI
   * prompt), so a get() + null-check is safe here. Passwords are discarded
   * immediately; the return value is boolean only.
   */
  async hasEntry(service: string, account: string): Promise<boolean> {
    const result = await this.get(service, account);
    return result !== null;
  }
}
