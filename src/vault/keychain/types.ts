/**
 * Adapter interface for OS-level secret storage.
 *
 * Each platform's adapter is backed by a native module (likely
 * @napi-rs/keyring, evaluated in Plan 5a) that talks to the OS keyring
 * through memory APIs — never argv. This avoids the `ps`-recoverable
 * password leak inherent in shell-CLI wrappers around `security`,
 * `secret-tool`, or PowerShell credential cmdlets.
 *
 * Plan 1 ships stubs only; Plan 5a wires in the real implementations.
 *
 * Keys are namespaced by (service, account). For Secret Shuttle's master key,
 * we use service = "secret-shuttle" and account = the daemon's unique vault id
 * (so multiple Secret Shuttle vaults don't collide on one machine).
 */
export interface KeychainAdapter {
  /** Returns true if the underlying keychain is reachable on this machine. */
  isAvailable(): Promise<boolean>;

  /**
   * Store `secret` under (service, account). Overwrites if present.
   * @throws ShuttleError("keychain_unavailable") if isAvailable() is false.
   */
  set(service: string, account: string, secret: Buffer): Promise<void>;

  /**
   * Retrieve the secret under (service, account). Returns null if not found.
   * @throws ShuttleError("keychain_unavailable") if isAvailable() is false.
   */
  get(service: string, account: string): Promise<Buffer | null>;

  /**
   * Delete the secret under (service, account). No-op if not present.
   * @throws ShuttleError("keychain_unavailable") if isAvailable() is false.
   */
  delete(service: string, account: string): Promise<void>;

  /**
   * Return true if an entry exists for (service, account) WITHOUT retrieving
   * the secret value. Never triggers OS credential UI (Touch ID, libsecret
   * prompt, DPAPI). Returns false on any lookup failure (not found, unavailable).
   *
   * Used by GET /v1/keychain/status to determine enrollment without pulling
   * plaintext into memory or triggering OS UI.
   */
  hasEntry(service: string, account: string): Promise<boolean>;
}
