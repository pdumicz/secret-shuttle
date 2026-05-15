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
}
