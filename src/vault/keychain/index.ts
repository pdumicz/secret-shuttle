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
 * class — note **all three are stubs in Plan 1**; Plan 5a replaces their
 * internals with native-module-backed implementations.
 *
 * On unsupported platforms, returns an UnsupportedKeychain that mirrors the
 * stub behavior (isAvailable → false; ops throw keychain_not_implemented).
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

  async hasEntry(): Promise<boolean> {
    return false;
  }
}
