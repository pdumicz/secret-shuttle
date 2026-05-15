import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ShuttleError } from "../shared/errors.js";
import { ensureShuttleHome, fileExists, getShuttlePaths } from "../shared/config.js";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const ALGO = "aes-256-gcm";
const KDF_N = 1 << 15;
const KDF_R = 8;
const KDF_P = 1;
const MAXMEM = 64 * 1024 * 1024;

export interface EnvelopeFile {
  version: 2;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number };
  salt: string;
  algorithm: "aes-256-gcm";
  nonce: string;
  authTag: string;
  ciphertext: string;
  created_at: string;
}

export async function encryptEnvelope(
  masterKey: Buffer,
  passphrase: string,
): Promise<EnvelopeFile> {
  if (masterKey.byteLength !== 32) {
    throw new ShuttleError("invalid_master_key", "Master key must be 32 bytes.");
  }
  if (passphrase.length === 0) {
    throw new ShuttleError("invalid_passphrase", "Passphrase must not be empty.");
  }

  const salt = randomBytes(16);
  const kek = await scryptAsync(passphrase, salt, 32, {
    N: KDF_N, r: KDF_R, p: KDF_P, maxmem: MAXMEM,
  });
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 2,
    kdf: "scrypt",
    kdfParams: { N: KDF_N, r: KDF_R, p: KDF_P },
    salt: salt.toString("base64url"),
    algorithm: ALGO,
    nonce: nonce.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    created_at: new Date().toISOString(),
  };
}

export async function readEnvelope(): Promise<EnvelopeFile | null> {
  const paths = getShuttlePaths();
  if (!(await fileExists(paths.envelopePath))) return null;
  const raw = await readFile(paths.envelopePath, "utf8");
  const parsed = JSON.parse(raw) as EnvelopeFile;
  if (parsed.version !== 2) {
    throw new ShuttleError("unsupported_envelope", "Envelope file version is not 2.");
  }
  return parsed;
}

export async function writeEnvelope(envelope: EnvelopeFile): Promise<void> {
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  await writeFile(paths.envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(paths.envelopePath, 0o600).catch(() => undefined);
}

export async function decryptEnvelope(
  envelope: EnvelopeFile,
  passphrase: string,
): Promise<Buffer> {
  if (envelope.version !== 2 || envelope.kdf !== "scrypt" || envelope.algorithm !== ALGO) {
    throw new ShuttleError("unsupported_envelope", "Unsupported envelope format.");
  }

  if (envelope.kdfParams.N < KDF_N || envelope.kdfParams.r < KDF_R || envelope.kdfParams.p < KDF_P) {
    throw new ShuttleError("unsupported_envelope", "Envelope KDF parameters are weaker than the current minimum.");
  }

  const salt = Buffer.from(envelope.salt, "base64url");
  const kek = await scryptAsync(passphrase, salt, 32, {
    N: envelope.kdfParams.N,
    r: envelope.kdfParams.r,
    p: envelope.kdfParams.p,
    maxmem: MAXMEM,
  });
  // decipher.final() throws if the GCM auth tag does not validate; plaintext is never returned on failure.
  try {
    const decipher = createDecipheriv(ALGO, kek, Buffer.from(envelope.nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    if (plain.byteLength !== 32) {
      throw new ShuttleError("vault_unlock_failed", "Unlocked key has wrong length.");
    }
    return plain;
  } catch (cause) {
    if (cause instanceof ShuttleError) throw cause;
    throw new ShuttleError("vault_unlock_failed", "Could not unlock the vault.");
  }
}
