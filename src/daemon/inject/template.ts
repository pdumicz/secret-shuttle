import { parseSecretRef, type ParsedSecretRef } from "../../shared/refs.js";

/**
 * Permissive candidate scanner: matches `ss://` followed by `source`, `env`,
 * and `name` segments using a greedy character class that mirrors the
 * underlying NAME_RE grammar. Each candidate is then validated by the
 * canonical `parseSecretRef` — invalid candidates are left as literal text.
 *
 * Why we capture greedy and validate post-hoc rather than one big regex:
 * a naive regex like `ss://[^/]+/[^/]+/[\w.-]+` would consume trailing
 * punctuation that's actually file syntax. The character class below stops
 * at any character outside NAME_RE — whitespace, quotes, brackets, commas,
 * semicolons, and `=` all terminate the candidate. Then parseSecretRef is
 * the SINGLE SOURCE OF TRUTH that says "yes, this is a valid ref" so the
 * template parser stays in lockstep with shared/refs.ts (if NAME_RE ever
 * changes, this picks it up for free).
 */
const CANDIDATE_RE = /ss:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z_][A-Za-z0-9_.-]*/g;

export interface ParsedTemplate {
  /** Deduped, canonicalized refs (matches `parseSecretRef(candidate).ref`). */
  refs: string[];
  /** Substitute each ref with the matching value from `values`. Throws if a value is missing. */
  render(values: Map<string, string>): string;
}

function tryParse(candidate: string): ParsedSecretRef | null {
  try {
    return parseSecretRef(candidate);
  } catch {
    return null;
  }
}

export function parseTemplate(template: string): ParsedTemplate {
  const found = new Set<string>();
  for (const m of template.matchAll(CANDIDATE_RE)) {
    const parsed = tryParse(m[0]);
    if (parsed !== null) found.add(parsed.ref);
  }
  const refs = [...found];

  const render = (values: Map<string, string>): string => {
    return template.replaceAll(CANDIDATE_RE, (match) => {
      const parsed = tryParse(match);
      if (parsed === null) return match; // invalid candidate — leave literal
      const v = values.get(parsed.ref);
      if (v === undefined) {
        throw new Error(`template: no value provided for ref ${parsed.ref}`);
      }
      return v;
    });
  };
  return { refs, render };
}
