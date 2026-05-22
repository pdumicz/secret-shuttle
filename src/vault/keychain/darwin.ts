import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

/**
 * macOS keychain adapter — Plan 1 stub.
 *
 * Plan 5a replaces this with a native-module-backed implementation
 * (likely @napi-rs/keyring) that uses Keychain Services through memory
 * APIs rather than argv. The shell-CLI approach (`security add-generic-
 * password -w <pw>`) is rejected because the password is recoverable
 * via `ps`.
 *
 * Until Plan 5a lands, init falls back to passphrase unlock on macOS.
 */
export class DarwinKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async set(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "macOS keychain adapter not yet implemented (planned for Plan 5a)",
    );
  }

  async get(): Promise<Buffer | null> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "macOS keychain adapter not yet implemented (planned for Plan 5a)",
    );
  }

  async delete(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "macOS keychain adapter not yet implemented (planned for Plan 5a)",
    );
  }
}
