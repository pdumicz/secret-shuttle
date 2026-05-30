import { ShuttleError } from "../../shared/errors.js";
import type { KeychainAdapter } from "./types.js";
import { DarwinKeychain } from "./darwin.js";
import { LinuxKeychain } from "./linux.js";
import { WindowsKeychain } from "./windows.js";

export type { KeychainAdapter } from "./types.js";

export type GetKeychainOptions = {
  /** Override the detected platform — used in tests. */
  platformOverride?: NodeJS.Platform;
};

/**
 * Return the platform-appropriate keychain adapter.
 *
 * On supported platforms (darwin, linux, win32), returns the per-platform
 * class — all three are real implementations backed by `@napi-rs/keyring`
 * (dynamically imported; `isAvailable()` returns false when the native
 * module can't load, so callers fall back to the passphrase UI).
 *
 * On unsupported platforms, returns an UnsupportedKeychain
 * (isAvailable → false; ops throw keychain_not_implemented).
 */
export function getKeychainAdapter(opts: GetKeychainOptions = {}): KeychainAdapter {
  const platform = opts.platformOverride ?? process.platform;
  switch (platform) {
    case "darwin":
      return new DarwinKeychain();
    case "linux":
      return new LinuxKeychain();
    case "win32":
      return new WindowsKeychain();
    default:
      return new UnsupportedKeychain(platform);
  }
}

class UnsupportedKeychain implements KeychainAdapter {
  constructor(private readonly platform: string) {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async set(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      `Keychain not supported on platform: ${this.platform}`,
    );
  }

  async get(): Promise<Buffer | null> {
    throw new ShuttleError(
      "keychain_not_implemented",
      `Keychain not supported on platform: ${this.platform}`,
    );
  }

  async delete(): Promise<void> {
    throw new ShuttleError(
      "keychain_not_implemented",
      `Keychain not supported on platform: ${this.platform}`,
    );
  }
}
