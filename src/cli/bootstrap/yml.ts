import { isIP } from "node:net";
import { parse as parseYaml } from "yaml";
import { ShuttleError } from "../../shared/errors.js";
import { parseSecretRef } from "../../shared/refs.js";

export type BootstrapSource =
  | { kind: "capture"; url: string; expected_host: string }
  | { kind: "human_paste"; url: string; expected_host: string }
  | { kind: "random_32_bytes" }
  | { kind: "random_64_bytes" }
  | { kind: "existing"; ref: string };

export interface BootstrapPlanSecret {
  name: string;
  source: BootstrapSource;
  destinations: string[]; // shorthand strings (resolved later by destination-shorthand.ts)
}

export interface BootstrapPlan {
  version: 1;
  secrets: BootstrapPlanSecret[];
}

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

function fail(message: string): never {
  throw new ShuttleError("bootstrap_plan_invalid", message);
}

export function parseBootstrapYml(yml: string): BootstrapPlan {
  let parsed: unknown;
  try {
    parsed = parseYaml(yml);
  } catch (e) {
    fail(`yaml parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("top-level must be a mapping");
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) {
    fail(`unsupported version: ${String(root.version)} (only version: 1 supported)`);
  }
  const secretsRaw = root.secrets;
  if (secretsRaw === null || typeof secretsRaw !== "object" || Array.isArray(secretsRaw)) {
    fail("`secrets` must be a mapping of name → entry");
  }
  const secrets: BootstrapPlanSecret[] = [];
  for (const [name, entryRaw] of Object.entries(secretsRaw as Record<string, unknown>)) {
    if (!ENV_VAR_NAME.test(name)) {
      fail(`secret name "${name}" must match ${ENV_VAR_NAME}`);
    }
    if (entryRaw === null || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      fail(`secrets.${name}: must be a mapping`);
    }
    const entry = entryRaw as Record<string, unknown>;
    const source = parseSource(name, entry.source);
    const destinations = parseDestinations(name, entry.destinations);
    secrets.push({ name, source, destinations });
  }
  return { version: 1, secrets };
}

function parseSource(secretName: string, raw: unknown): BootstrapSource {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`secrets.${secretName}.source: must be a mapping with { kind }`);
  }
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (kind === "capture" || kind === "human_paste") {
    if (typeof s.url !== "string" || s.url.length === 0) {
      fail(`secrets.${secretName}.source: kind=${kind} requires url`);
    }
    // Strict URL validation for both capture and human_paste sources.
    // These checks use bootstrap_capture_url_invalid (not the generic
    // bootstrap_plan_invalid) so the CLI can surface a targeted hint
    // ("fix the capture URL in your bootstrap yml") without re-classifying
    // the basic-shape failure above.
    const result = validateCaptureUrl(s.url);
    if (!result.ok) {
      throw new ShuttleError(
        "bootstrap_capture_url_invalid",
        `secrets.${secretName}.source.url ${result.reason}`,
      );
    }
    return { kind, url: s.url, expected_host: result.host };
  }
  if (kind === "random_32_bytes") return { kind: "random_32_bytes" };
  if (kind === "random_64_bytes") return { kind: "random_64_bytes" };
  if (kind === "existing") {
    if (typeof s.ref !== "string" || !s.ref.startsWith("ss://")) {
      fail(`secrets.${secretName}.source: kind=existing requires ref (ss://...)`);
    }
    // Validate the full ref shape (source/environment/name segments + regex
    // checks) at parse time, BEFORE the approval is minted. Without this, a
    // malformed ref like "ss://local/prod" (missing name segment) would still
    // pass the .startsWith("ss://") check, flow through to plan construction,
    // trigger planHasProductionSource's fail-closed branch (which mints an
    // approval), and only fail at executor time with no actionable recovery.
    // Store the CANONICAL ref so downstream code (planHasProductionSource,
    // executor.runSourceStep → vault.getSecret) operates on the same key shape
    // the vault uses. Without canonicalization, a user typing
    // "ss://local/production/X" (long-form env) or "ss://LOCAL/prod/X"
    // (uppercase host) would pass yml validation, pass the approval gate, then
    // fail at /continue with secret_not_found because vault lookups are exact-match.
    let parsed;
    try {
      parsed = parseSecretRef(s.ref);
    } catch (e) {
      fail(
        `secrets.${secretName}.source.ref ${JSON.stringify(s.ref)} is not a valid ss:// ref: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return { kind: "existing", ref: parsed.ref };
  }
  fail(
    `secrets.${secretName}.source.kind: unknown "${String(kind)}" (allowed: capture, human_paste, random_32_bytes, random_64_bytes, existing)`,
  );
}

function parseDestinations(secretName: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    fail(`secrets.${secretName}.destinations: must be an array`);
  }
  if (raw.length === 0) {
    fail(`secrets.${secretName}.destinations: must have at least one entry`);
  }
  const out: string[] = [];
  for (const d of raw) {
    if (typeof d !== "string" || d.length === 0) {
      fail(`secrets.${secretName}.destinations: entries must be non-empty strings`);
    }
    out.push(d);
  }
  return out;
}

/**
 * Pure URL validator for capture sources. Mirrors every check the
 * executor (parseSource above) applies. Used by parseSource (which
 * converts a failure to a thrown ShuttleError) AND by
 * src/cli/provision/infer-gate.ts (which converts a failure to an
 * InferGateIssue). Shared logic = no drift between gate and executor.
 *
 * Returns the same checks in the same order as parseSource so
 * error messages stay aligned. On success, returns the canonicalized
 * host (lowercased + trailing-dot stripped) so callers don't need to
 * re-parse the URL.
 */
export function validateCaptureUrl(
  url: string,
): { ok: true; host: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: `is not a valid URL: ${JSON.stringify(url)}` };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "must be https" };
  if (u.username !== "" || u.password !== "") {
    return { ok: false, reason: "must not embed credentials" };
  }
  // Canonicalize the host: lowercase + strip trailing dot. For IPv6 the
  // URL parser keeps the square brackets in hostname; strip them only for
  // the isIP check (the bracketed form isn't a valid IP literal).
  const hostRaw = u.hostname.toLowerCase();
  const host = hostRaw.endsWith(".") ? hostRaw.slice(0, -1) : hostRaw;
  const hostForIp = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(hostForIp) !== 0) {
    return { ok: false, reason: "must not target an IP literal" };
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "must not target localhost" };
  }
  return { ok: true, host };
}
