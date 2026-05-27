import { ShuttleError } from "../shared/errors.js";

export class LockedVaultState {
  private key: Buffer | null = null;

  isUnlocked(): boolean {
    return this.key !== null;
  }

  unlock(key: Buffer): void {
    if (key.byteLength !== 32) {
      throw new ShuttleError("invalid_master_key", "Master key must be 32 bytes.");
    }
    if (this.key !== null) {
      this.key.fill(0);
    }
    this.key = Buffer.from(key);
  }

  lock(): void {
    if (this.key !== null) {
      this.key.fill(0);
      this.key = null;
    }
  }

  requireKey(): Buffer {
    if (this.key === null) {
      throw new ShuttleError(
        "vault_locked",
        "The Secret Shuttle vault is locked. Run `secret-shuttle unlock`.",
      );
    }
    return Buffer.from(this.key);
  }

  /**
   * Same guard as requireKey() — throws ShuttleError("vault_locked") if locked
   * — but does NOT allocate a Buffer copy. Use this when you only need to
   * verify the vault is unlocked, not to consume the key. The vast majority
   * of route handlers use the guard idiom (`services.lock.requireKey();`
   * with the return value discarded), and were thereby leaking a 32-byte
   * Buffer per call onto the heap until GC.
   */
  assertUnlocked(): void {
    if (this.key === null) {
      throw new ShuttleError(
        "vault_locked",
        "The Secret Shuttle vault is locked. Run `secret-shuttle unlock`.",
      );
    }
  }
}
