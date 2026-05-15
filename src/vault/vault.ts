import { randomUUID } from "node:crypto";
import { ensureShuttleHome, fileExists, getShuttlePaths, readJsonFile, writeJsonFileAtomic } from "../shared/config.js";
import { ShuttleError } from "../shared/errors.js";
import { buildSecretRef, canonicalEnvironment } from "../shared/refs.js";
import { decryptVault, encryptVault } from "./crypto.js";
import { fingerprintSecret } from "./fingerprints.js";
import type {
  AgentSecretMetadata,
  EncryptedVaultFile,
  SecretAction,
  SecretRecord,
  UpsertSecretInput,
  VaultPlaintext,
} from "./types.js";

const DEFAULT_ACTIONS: SecretAction[] = [
  "capture_from_page",
  "inject_into_field",
  "compare_fingerprint",
  "use_as_stdin",
];

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
      fingerprint: fingerprintSecret(input.value),
      allowed_domains: normalizeDomains(input.allowedDomains),
      allowed_actions: input.allowedActions ?? DEFAULT_ACTIONS,
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

  async list(filters: { environment?: string; source?: string } = {}): Promise<AgentSecretMetadata[]> {
    const plaintext = await this.read();
    const environment =
      filters.environment !== undefined ? canonicalEnvironment(filters.environment) : undefined;
    const source = filters.source?.toLowerCase();

    return plaintext.secrets
      .filter((secret) => environment === undefined || secret.environment === environment)
      .filter((secret) => source === undefined || secret.source === source)
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .map(toAgentMetadata);
  }

  async inspect(ref: string): Promise<AgentSecretMetadata> {
    const record = await this.getSecret(ref);
    return toAgentMetadata(record);
  }

  async getSecret(ref: string): Promise<SecretRecord> {
    const plaintext = await this.read();
    const secret = plaintext.secrets.find((candidate) => candidate.ref === ref);
    if (secret === undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    return secret;
  }

  async markUsed(ref: string): Promise<void> {
    const plaintext = await this.read();
    const secret = plaintext.secrets.find((candidate) => candidate.ref === ref);
    if (secret === undefined) {
      throw new ShuttleError("secret_not_found", `Secret ${ref} was not found.`);
    }
    secret.last_used_at = new Date().toISOString();
    secret.updated_at = secret.updated_at;
    await this.write(plaintext);
  }

  private async read(): Promise<VaultPlaintext> {
    const paths = getShuttlePaths();
    if (!(await fileExists(paths.vaultPath))) {
      throw new ShuttleError("vault_not_initialized", "Secret Shuttle is not initialized. Run `secret-shuttle init`.");
    }
    const key = this.keyProvider();
    const file = await readJsonFile<EncryptedVaultFile>(paths.vaultPath);
    const plaintext = decryptVault(file, key);
    if (plaintext.version !== 1 || !Array.isArray(plaintext.secrets)) {
      throw new ShuttleError("invalid_vault", "Secret Shuttle vault contents are invalid.");
    }
    return plaintext;
  }

  private async write(plaintext: VaultPlaintext): Promise<void> {
    const paths = getShuttlePaths();
    await ensureShuttleHome(paths);
    const key = this.keyProvider();
    await writeJsonFileAtomic(paths.vaultPath, encryptVault(plaintext, key));
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
  };
}

function normalizeDomains(domains: string[]): string[] {
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
}
