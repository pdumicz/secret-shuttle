export type SecretEnvironment = "production" | "development" | string;

export type SecretAction =
  | "capture_from_page"
  | "inject_into_field"
  | "compare_fingerprint"
  | "use_as_stdin"
  | "inject_submit";

// Canonical runtime enumeration of SecretAction. Request validation derives
// from this (never re-lists actions). NOTE: this is "all known actions" — it is
// deliberately NOT the same concept as vault.ts `DEFAULT_ACTIONS` ("actions
// granted by default"), which stays an explicit policy list so a future action
// is never silently default-granted.
export const ALL_SECRET_ACTIONS: readonly SecretAction[] = Object.freeze([
  "capture_from_page",
  "inject_into_field",
  "compare_fingerprint",
  "use_as_stdin",
  "inject_submit",
]);

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
  /** ISO-8601 if soft-deleted; field absent otherwise. */
  deleted_at?: string;
  /** True if a newer ref has superseded this one but it hasn't been deleted yet. Operational state — not surfaced to agents. */
  rotating?: boolean;
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
  /** ISO-8601 if soft-deleted; field absent otherwise. */
  deleted_at?: string;
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
