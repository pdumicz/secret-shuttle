export type SecretEnvironment = "production" | "development" | string;

export type SecretAction =
  | "capture_from_page"
  | "inject_into_field"
  | "compare_fingerprint"
  | "use_as_stdin";

export interface SecretRecord {
  id: string;
  ref: string;
  name: string;
  environment: SecretEnvironment;
  source: string;
  description?: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  fingerprint: string;
  allowed_domains: string[];
  allowed_actions: SecretAction[];
  requires_approval: boolean;
  classification: "production_secret" | "secret";
  value: string;
}

export interface AgentSecretMetadata {
  id: string;
  ref: string;
  name: string;
  environment: SecretEnvironment;
  source: string;
  description?: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  fingerprint: string;
  allowed_domains: string[];
  allowed_actions: SecretAction[];
  requires_approval: boolean;
  classification: "production_secret" | "secret";
  value_visible_to_agent: false;
}

export interface VaultPlaintext {
  version: 1;
  secrets: SecretRecord[];
  fingerprint_key?: string;
}

export interface EncryptedVaultFile {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  authTag: string;
  ciphertext: string;
}

export interface MasterKeyFile {
  version: 1;
  algorithm: "aes-256-gcm";
  key: string;
  storage: "local-file";
  warning: string;
}

export interface UpsertSecretInput {
  name: string;
  environment: string;
  source: string;
  value: string;
  description?: string;
  allowedDomains: string[];
  allowedActions?: SecretAction[];
  requiresApproval?: boolean;
  force?: boolean;
}
