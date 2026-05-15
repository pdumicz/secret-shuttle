import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ShuttleError } from "../shared/errors.js";
import type { EncryptedVaultFile, VaultPlaintext } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;

export function createMasterKey(): Buffer {
  return randomBytes(32);
}

export function encodeKey(key: Buffer): string {
  return key.toString("base64url");
}

export function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32) {
    throw new ShuttleError("invalid_master_key", "Secret Shuttle master key must be 32 bytes.");
  }
  return key;
}

export function encryptVault(plaintext: VaultPlaintext, key: Buffer): EncryptedVaultFile {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: ALGORITHM,
    nonce: nonce.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptVault(file: EncryptedVaultFile, key: Buffer): VaultPlaintext {
  if (file.version !== 1 || file.algorithm !== ALGORITHM) {
    throw new ShuttleError("unsupported_vault", "Unsupported Secret Shuttle vault format.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(file.nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(file.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as VaultPlaintext;
  } catch {
    throw new ShuttleError(
      "vault_decryption_failed",
      "Could not decrypt the Secret Shuttle vault. Check the master key and vault files.",
    );
  }
}
