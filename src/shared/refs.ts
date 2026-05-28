import { ShuttleError } from "./errors.js";

const SOURCE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ENV_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface ParsedSecretRef {
  source: string;
  environment: string;
  refEnvironment: string;
  name: string;
  ref: string;
}

export function canonicalEnvironment(environment: string): string {
  const value = environment.trim().toLowerCase();
  if (value === "prod" || value === "production") {
    return "production";
  }
  if (value === "dev" || value === "development") {
    return "development";
  }
  return value;
}

export function refEnvironment(environment: string): string {
  const canonical = canonicalEnvironment(environment);
  if (canonical === "production") {
    return "prod";
  }
  if (canonical === "development") {
    return "dev";
  }
  return canonical;
}

export function assertSecretParts(source: string, environment: string, name: string): void {
  if (!SOURCE_RE.test(source)) {
    throw new ShuttleError(
      "invalid_source",
      "Secret source must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes.",
    );
  }
  if (!ENV_RE.test(refEnvironment(environment))) {
    throw new ShuttleError(
      "invalid_environment",
      "Secret environment must contain only letters, numbers, dots, underscores, or dashes.",
    );
  }
  if (!NAME_RE.test(name)) {
    throw new ShuttleError(
      "invalid_name",
      "Secret name must start with a letter or underscore and contain only letters, numbers, dots, underscores, or dashes.",
    );
  }
}

/**
 * Validate a raw --environment scalar (CLI / API surface) against the
 * canonical ENV_RE grammar. Single source of truth for environment
 * grammar across the codebase; call sites that previously open-coded a
 * parallel regex (e.g. provision.ts validateProvisionScalars) must
 * route through this helper to stay in sync.
 *
 * Shell-safety guarantee: ENV_RE limits characters to [a-zA-Z0-9._-]
 * and requires alphanumeric first, so every shell metacharacter
 * (whitespace, ;, &, |, $, `, \, ', ", <, >, *, ?, (, ), etc.) and the
 * argv-leading `-` (which would be parsed as a flag) are rejected.
 * That is the same guarantee the round-2 fix in provision.ts relied
 * on, recentered on the canonical grammar.
 */
export function assertEnvironmentValid(env: string): void {
  if (!ENV_RE.test(env)) {
    throw new ShuttleError(
      "invalid_environment",
      `Environment must match ${ENV_RE.source} (alphanumeric first, then alphanumeric, dot, underscore, or hyphen); got '${env}'.`,
    );
  }
}

export function buildSecretRef(source: string, environment: string, name: string): string {
  const normalizedSource = source.trim().toLowerCase();
  const normalizedName = name.trim();
  assertSecretParts(normalizedSource, environment, normalizedName);
  return `ss://${normalizedSource}/${refEnvironment(environment)}/${normalizedName}`;
}

export function parseSecretRef(ref: string): ParsedSecretRef {
  if (!ref.startsWith("ss://")) {
    throw new ShuttleError("invalid_ref", "Secret refs must start with ss://.");
  }

  const url = new URL(ref);
  const source = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new ShuttleError("invalid_ref", "Secret refs must use ss://source/environment/name.");
  }

  const environment = canonicalEnvironment(parts[0]);
  const name = decodeURIComponent(parts[1]);
  const normalizedRef = buildSecretRef(source, environment, name);
  return {
    source,
    environment,
    refEnvironment: refEnvironment(environment),
    name,
    ref: normalizedRef,
  };
}
