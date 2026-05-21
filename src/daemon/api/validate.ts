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
