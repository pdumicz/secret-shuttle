import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";

/**
 * Linux keychain adapter — Plan 1 stub.
 *
 * Plan 5a replaces this with a native-module-backed adapter that talks
 * to libsecret through memory APIs (not the `secret-tool` CLI, which
 * would put the password in argv). Until then, init falls back to
 * passphrase unlock on Linux.
 */
export class LinuxKeychain implements KeychainAdapter {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async set(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Linux keychain adapter not yet implemented (planned for Plan 5a, native-module-backed)",
    );
  }

  async get(): Promise<Buffer | null> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Linux keychain adapter not yet implemented (planned for Plan 5a, native-module-backed)",
    );
  }

  async delete(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      "Linux keychain adapter not yet implemented (planned for Plan 5a, native-module-backed)",
    );
  }
}
