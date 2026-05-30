import { randomBytes, randomUUID } from "node:crypto";
import { ensureShuttleHome, fileExists, getShuttlePaths, readJsonFile, writeJsonFileAtomic } from "../shared/config.js";
import { ShuttleError } from "../shared/errors.js";
import { buildSecretRef, canonicalEnvironment } from "../shared/refs.js";
import { generateSecretValue } from "../daemon/helpers/generate-value.js";
import { decryptVault, encryptVault } from "./crypto.js";
import { fingerprintSecret, isLegacyFingerprint } from "./fingerprints.js";
import type {
  AgentSecretMetadata,
  EncryptedVaultFile,
  SecretAction,
  SecretRecord,
  UpsertSecretInput,
  VaultPlaintext,
} from "./types.js";

export const DEFAULT_ACTIONS: readonly SecretAction[] = Object.freeze([
  "capture_from_page",
  "inject_into_field",
  "compare_fingerprint",
  "use_as_stdin",
  "inject_submit",
]);

export class Vault {
  constructor(private readonly keyProvider: () => Buffer) {}

  async ensureInitialized(): Promise<{ created: boolean; vaultPath: string }> {
    const paths = getShuttlePaths();
    await ensureShuttleHome(paths);

    if (await fileExists(paths.vaultPath)) {
      await this.read();
      return {
        created: false,
        vaultPath: paths.vaultPath,
      };
    }

    await this.write({
      version: 1,
      secrets: [],
      fingerprint_key: randomBytes(32).toString("base64"),
    });

    await writeJsonFileAtomic(paths.configPath, {
      version: 2,
      created_at: new Date().toISOString(),
      vault_path: paths.vaultPath,
      security_model: "daemon_secure_mode_v2",
      raw_secret_read_api: false,
    });

    return {
      created: true,
      vaultPath: paths.vaultPath,
    };
  }

  async upsertSecret(input: UpsertSecretInput): Promise<AgentSecretMetadata> {
    const plaintext = await this.read();
    const environment = canonicalEnvironment(input.environment);
    const ref = buildSecretRef(input.source, environment, input.name);
    const existing = plaintext.secrets.find((secret) => secret.ref === ref);

    if (existing !== undefined && input.force !== true) {
      throw new ShuttleError(
        "secret_exists",
        `Secret ${ref} already exists. Re-run with --force to overwrite it.`,
      );
    }

    const now = new Date().toISOString();
    const record: SecretRecord = {
      id: existing?.id ?? `sec_${randomUUID().replaceAll("-", "")}`,
      ref,
      name: input.name,
      environment,
      source: input.source.toLowerCase(),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_used_at: existing?.last_used_at ?? null,
      fingerprint: fingerprintSecret(Buffer.from(input.value, "utf8"), Buffer.from(plaintext.fingerprint_key as string, "base64")),
      allowed_domains: normalizeDomains(input.allowedDomains),
      // Explicit caller-supplied actions win. Otherwise: a brand-new record gets
      // the extended default set; an OVERWRITE preserves the prior record's
      // allowed_actions so a force-rotate never silently widens scope (§4.4).
      allowed_actions:
        input.allowedActions ?? (existing !== undefined ? [...existing.allowed_actions] : [...DEFAULT_ACTIONS]),
      requires_approval: input.requiresApproval ?? environment === "production",
      classification: environment === "production" ? "production_secret" : "secret",
      value: input.value,
      ...(input.description !== undefined ? { description: input.description } : {}),
    };

    if (existing === undefined) {
      plaintext.secrets.push(record);
    } else {
      const index = plaintext.secrets.findIndex((secret) => secret.ref === ref);
      plaintext.secrets[index] = record;
    }

    await this.write(plaintext);
    return toAgentMetadata(record);
  }

  async list(
    filters: { environment?: string; source?: string; includeDeleted?: boolean } = {},
  ): Promise<AgentSecretMetadata[]> {
    const plaintext = await this.read();
    const environment =
      filters.environment !== undefined ? canonicalEnvironment(filters.environment) : undefined;
    const source = filters.source?.toLowerCase();

    return plaintext.secrets
      .filter((secret) => filters.includeDeleted === true || secret.deleted_at === undefined)
      .filter((secret) => environment === undefined || secret.environment === environment)
      .filter((secret) => source === undefined || secret.source === source)
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .map(toAgentMetadata);
  }

  async inspect(ref: string): Promise<AgentSecretMetadata> {
    const plaintext = await this.read();
    const secret = plaintext.secrets.find((candidate) => candidate.ref === ref);
    if (secret === undefined || secret.deleted_at !== undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    return toAgentMetadata(secret);
  }

  async getSecret(ref: string): Promise<SecretRecord> {
    const plaintext = await this.read();
    const secret = plaintext.secrets.find((candidate) => candidate.ref === ref);
    if (secret === undefined || secret.deleted_at !== undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    return secret;
  }

  async softDelete(ref: string): Promise<{ ref: string; deleted_at: string }> {
    const plaintext = await this.read();
    const idx = plaintext.secrets.findIndex((s) => s.ref === ref);
    if (idx === -1 || plaintext.secrets[idx]!.deleted_at !== undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    const now = new Date().toISOString();
    plaintext.secrets[idx] = { ...plaintext.secrets[idx]!, deleted_at: now };
    await this.write(plaintext);
    return { ref, deleted_at: now };
  }

  async markUsed(ref: string): Promise<void> {
    const plaintext = await this.read();
    const secret = plaintext.secrets.find((candidate) => candidate.ref === ref);
    if (secret === undefined || secret.deleted_at !== undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    secret.last_used_at = new Date().toISOString();
    secret.updated_at = secret.updated_at;
    await this.write(plaintext);
  }

  async markRotating(ref: string): Promise<void> {
    const plaintext = await this.read();
    const idx = plaintext.secrets.findIndex((s) => s.ref === ref);
    if (idx === -1 || plaintext.secrets[idx]!.deleted_at !== undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    plaintext.secrets[idx] = { ...plaintext.secrets[idx]!, rotating: true };
    await this.write(plaintext);
  }

  /**
   * Generate a new secret value of the given kind and upsert it. Used by both
   * the /v1/secrets/generate route (after approval) and /v1/secrets/rotate
   * (after secrets_rotate approval) to avoid duplicating value-generation logic.
   * Approval enforcement is the caller's responsibility — this method does not
   * itself require approval.
   */
  async generate(input: {
    name: string;
    environment: string;
    source: string;
    kind: string;
    allowed_domains: string[];
    allowed_actions?: SecretAction[];
    description?: string;
    force?: boolean;
  }): Promise<SecretRecord> {
    const value = generateSecretValue(input.kind);
    await this.upsertSecret({
      name: input.name,
      environment: input.environment,
      source: input.source,
      value,
      allowedDomains: input.allowed_domains,
      ...(input.allowed_actions !== undefined ? { allowedActions: input.allowed_actions } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.force !== undefined ? { force: input.force } : {}),
    });
    // Return the canonical stored record (with `ref`) — read it back from the
    // freshly persisted vault to keep generate/rotate code paths uniform.
    const env = canonicalEnvironment(input.environment);
    const ref = buildSecretRef(input.source, env, input.name);
    return this.getSecret(ref);
  }

  private async read(): Promise<VaultPlaintext> {
    const paths = getShuttlePaths();
    if (!(await fileExists(paths.vaultPath))) {
      throw new ShuttleError("vault_not_initialized", "Secret Shuttle is not initialized. Run `secret-shuttle init`.");
    }
    // No key needed for the file read — defer requireKey() until immediately
    // before the sync decrypt so the master-key copy doesn't linger across an
    // await that doesn't need it.
    const file = await readJsonFile<EncryptedVaultFile>(paths.vaultPath);
    const key = this.keyProvider();
    let plaintext: VaultPlaintext;
    try {
      plaintext = decryptVault(file, key);
    } finally {
      // Scrub the key copy in `finally` so a throw from decryptVault (e.g.
      // corrupt file) still wipes the master-key bytes from this Buffer.
      key.fill(0);
    }
    if (plaintext.version !== 1 || !Array.isArray(plaintext.secrets)) {
      throw new ShuttleError("invalid_vault", "Secret Shuttle vault contents are invalid.");
    }
    if (this.migrateFingerprints(plaintext)) {
      // write() acquires its own keyProvider() copy and scrubs it in its own
      // try/finally — no coordination needed here.
      await this.write(plaintext);
    }
    return plaintext;
  }

  /** One-shot transparent upgrade: ensure a per-vault HMAC key and re-key any
   *  legacy raw-sha256 fingerprints. Returns true if the vault must be persisted. */
  private migrateFingerprints(pt: VaultPlaintext): boolean {
    let dirty = false;
    if (typeof pt.fingerprint_key !== "string" || pt.fingerprint_key === "") {
      pt.fingerprint_key = randomBytes(32).toString("base64");
      dirty = true;
    }
    const fpKey = Buffer.from(pt.fingerprint_key, "base64");
    for (const s of pt.secrets) {
      if (isLegacyFingerprint(s.fingerprint)) {
        s.fingerprint = fingerprintSecret(Buffer.from(s.value, "utf8"), fpKey);
        dirty = true;
      }
    }
    return dirty;
  }

  /**
   * Resolve a list of ss:// refs to a Map<ref, SecretRecord>. Uses the
   * deleted-aware getSecret() so refs that have been soft-deleted throw
   * secret_not_found. Single-pass — fails fast on the first missing ref.
   * Dedupes input. Callers should do assertSecretActionAllowed + markUsed
   * on each returned record.
   */
  async resolveRefs(refs: readonly string[]): Promise<Map<string, SecretRecord>> {
    const result = new Map<string, SecretRecord>();
    for (const ref of refs) {
      if (result.has(ref)) continue; // dedupe
      const record = await this.getSecret(ref);
      result.set(ref, record);
    }
    return result;
  }

  /** Daemon-internal: the per-vault fingerprint HMAC key (never exposed to agents). */
  async fingerprintKey(): Promise<Buffer> {
    const pt = await this.read();
    return Buffer.from(pt.fingerprint_key as string, "base64");
  }

  private async write(plaintext: VaultPlaintext): Promise<void> {
    const paths = getShuttlePaths();
    await ensureShuttleHome(paths);
    // Defer requireKey() until immediately before the sync encrypt — the file
    // write that follows doesn't need the key, so don't hold it across that
    // await.
    const key = this.keyProvider();
    let encrypted: EncryptedVaultFile;
    try {
      encrypted = encryptVault(plaintext, key);
    } finally {
      // Scrub in `finally` so an encryptVault throw (rare — only on internal
      // error) still wipes the master-key bytes from this Buffer.
      key.fill(0);
    }
    await writeJsonFileAtomic(paths.vaultPath, encrypted);
  }
}

export function toAgentMetadata(secret: SecretRecord): AgentSecretMetadata {
  return {
    id: secret.id,
    ref: secret.ref,
    name: secret.name,
    environment: secret.environment,
    source: secret.source,
    created_at: secret.created_at,
    updated_at: secret.updated_at,
    last_used_at: secret.last_used_at,
    fingerprint: secret.fingerprint,
    allowed_domains: [...secret.allowed_domains],
    allowed_actions: [...secret.allowed_actions],
    requires_approval: secret.requires_approval,
    classification: secret.classification,
    value_visible_to_agent: false,
    ...(secret.description !== undefined ? { description: secret.description } : {}),
    ...(secret.deleted_at !== undefined ? { deleted_at: secret.deleted_at } : {}),
  };
}

function normalizeDomains(domains: string[]): string[] {
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
}
