import { ShuttleError } from "../../shared/errors.js";

function bad(field: string, reason: string): never {
  throw new ShuttleError("bad_request", `${field}: ${reason}`);
}

export function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ShuttleError("bad_request", "body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

export function reqString(o: Record<string, unknown>, f: string): string {
  const v = o[f];
  if (typeof v !== "string" || v === "") bad(f, "required non-empty string");
  return v as string;
}

export function optString(o: Record<string, unknown>, f: string): string | undefined {
  const v = o[f];
  if (v === undefined) return undefined;
  if (typeof v !== "string") bad(f, "must be a string");
  return v;
}

export function optStringArray(o: Record<string, unknown>, f: string): string[] | undefined {
  const v = o[f];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad(f, "must be a string array");
  return v as string[];
}

export function optBool(o: Record<string, unknown>, f: string): boolean | undefined {
  const v = o[f];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") bad(f, "must be a boolean");
  return v;
}

export function optStringRecord(
  o: Record<string, unknown>,
  f: string,
): Record<string, string> | undefined {
  const v = o[f];
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    bad(f, "must be a string-to-string record");
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") bad(f, `value for "${k}" must be a string`);
    out[k] = val;
  }
  return out;
}

/**
 * Read the approval-id payload from a request body. Accepts either:
 *   - approval_ids: string[]
 *   - approval_id: string  (legacy alias; deprecated; kept for one release)
 * Rejects:
 *   - both fields supplied → bad_request "approval_id_and_approval_ids_supplied"
 *   - approval_ids has duplicates → bad_request "duplicate_approval_id"
 * Empty array is treated as if the field were omitted (returns undefined).
 */
export function optApprovalIds(o: Record<string, unknown>): string[] | undefined {
  const singular = o["approval_id"];
  const plural = o["approval_ids"];
  if (singular !== undefined && plural !== undefined) {
    throw new ShuttleError(
      "bad_request",
      "approval_id_and_approval_ids_supplied: send either approval_id (legacy) or approval_ids (canonical), not both",
    );
  }
  if (singular !== undefined) {
    if (typeof singular !== "string") {
      throw new ShuttleError("bad_request", "approval_id: must be a string");
    }
    return [singular];
  }
  if (plural === undefined) return undefined;
  if (!Array.isArray(plural)) {
    throw new ShuttleError("bad_request", "approval_ids: must be a string array");
  }
  for (const x of plural) {
    if (typeof x !== "string") {
      throw new ShuttleError("bad_request", "approval_ids: each entry must be a string");
    }
  }
  if (plural.length === 0) return undefined;
  const seen = new Set<string>();
  for (const x of plural) {
    if (seen.has(x)) {
      throw new ShuttleError(
        "bad_request",
        `duplicate_approval_id: ${x} appears more than once in approval_ids`,
      );
    }
    seen.add(x);
  }
  return plural;
}
