import { timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

const REDACTED = "[secret]";

/**
 * A secret's plaintext bytes, wrapped so accidental stringification redacts
 * instead of leaking. The ONLY way to read the bytes is `.bytes()`, which is
 * greppable + auditable. toString/toJSON/[inspect.custom] all return
 * "[secret]", so `${sv}`, JSON.stringify(sv), console.log(sv), and
 * template/log interpolation cannot leak the value. Call dispose() after use
 * to zero the backing Buffer. (Burst 7 §2 / Plan 5q.)
 */
export class SecretValue {
  #buf: Buffer;
  #disposed = false;

  private constructor(buf: Buffer) {
    this.#buf = buf;
  }

  static fromUtf8(s: string): SecretValue {
    return new SecretValue(Buffer.from(s, "utf8"));
  }

  static fromBuffer(b: Buffer): SecretValue {
    return new SecretValue(Buffer.from(b)); // defensive copy
  }

  /** The plaintext bytes. Throws if already disposed. The single audited door. */
  bytes(): Buffer {
    if (this.#disposed) throw new Error("SecretValue used after dispose()");
    return this.#buf;
  }

  /** Byte length (safe to expose — not the value). */
  get byteLength(): number {
    return this.#buf.length;
  }

  /** Constant-time compare against another secret's bytes. */
  equals(other: SecretValue): boolean {
    const a = this.bytes();
    const b = other.bytes();
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Zero the backing buffer. Idempotent. */
  dispose(): void {
    this.#buf.fill(0);
    this.#disposed = true;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
