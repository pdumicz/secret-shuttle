/**
 * Derive session patterns from a BatchState.plan for the
 * approval-UI session affordance. Pure function. See Burst 5 spec
 * §2 "Pattern derivation."
 *
 * Invariants:
 * - Every emitted pattern's `ref_glob` is an exact ref (no trailing *).
 *   See spec §2 "No glob collapsing in derivation."
 * - Destinations whose template_id is NOT in DESTINATION_DEFINING_PARAMS
 *   are excluded (fail-closed).
 * - One pattern per (ref, destination-shape) tuple.
 */
import type { PlanEntry, ResolvedDestination } from "../bootstrap/store.js";
import type { SessionPattern } from "./session.js";
import { destinationDefiningParamsFor } from "../templates/destination-defining-params.js";

export interface InferSessionPatternResult {
  patterns: SessionPattern[];
  excluded: Array<
    | { secret: string; ref: string; destination: ResolvedDestination; reason: "template_unregistered"; template_id: string }
    | { secret: string; ref: string; destination: ResolvedDestination; reason: "missing_defining_params"; template_id: string; missing_keys: string[] }
  >;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min — overridden by ui body at create time

export function inferSessionPatternFromPlan(plan: PlanEntry[], ttl_ms: number = DEFAULT_TTL_MS): InferSessionPatternResult {
  const patterns: SessionPattern[] = [];
  const excluded: InferSessionPatternResult["excluded"] = [];

  for (const entry of plan) {
    for (const dest of entry.destinations) {
      const definingKeys = destinationDefiningParamsFor(dest.template_id);
      if (definingKeys === null) {
        excluded.push({ secret: entry.secret, ref: entry.ref, destination: dest, reason: "template_unregistered", template_id: dest.template_id });
        continue;
      }

      // Fail-closed: if a registered template lists ["name", "environment"]
      // and the destination's template_params is missing one of them
      // (or has a non-string value), we cannot construct a narrowing
      // SessionPattern for it. Emitting a broader pattern is the exact
      // consent-widening footgun this primitive closes. Exclude instead.
      const required_params: Record<string, string> = {};
      const missingKeys: string[] = [];
      for (const k of definingKeys) {
        const v = dest.template_params[k];
        if (typeof v === "string" && v.length > 0) {
          required_params[k] = v;
        } else {
          missingKeys.push(k);
        }
      }
      if (missingKeys.length > 0) {
        excluded.push({
          secret: entry.secret,
          ref: entry.ref,
          destination: dest,
          reason: "missing_defining_params",
          template_id: dest.template_id,
          missing_keys: missingKeys,
        });
        continue;
      }

      const pattern: SessionPattern = {
        actions: ["template-run"],
        ref_glob: entry.ref, // ALWAYS exact ref — no globbing
        destination_domains: [dest.domain],
        template_ids: [dest.template_id],
        ttl_ms,
        required_params, // guaranteed non-empty above
      };
      patterns.push(pattern);
    }
  }

  // Dedup: same SessionPattern shape emitted twice → keep one.
  const seen = new Set<string>();
  const deduped: SessionPattern[] = [];
  for (const p of patterns) {
    const key = JSON.stringify(p);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(p);
    }
  }

  return { patterns: deduped, excluded };
}
