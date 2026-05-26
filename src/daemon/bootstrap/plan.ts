import type { BootstrapPlan } from "../../cli/bootstrap/yml.js";
import { resolveDestinationShorthand } from "../../cli/bootstrap/destination-shorthand.js";
import type { PlanEntry, ResolvedDestination, BootstrapSource } from "./store.js";
import { buildSecretRef, canonicalEnvironment } from "../../shared/refs.js";

interface PlanContext {
  source: string;
  environment: string;
  force: boolean;
}

interface VaultLike {
  has(ref: string): boolean;
}

export function computeBootstrapPlan(
  parsed: BootstrapPlan,
  vault: VaultLike,
  ctx: PlanContext,
): PlanEntry[] {
  const out: PlanEntry[] = [];
  for (const s of parsed.secrets) {
    const ref =
      s.source.kind === "existing"
        ? s.source.ref
        : buildSecretRef(ctx.source, canonicalEnvironment(ctx.environment), s.name);

    // The vault.has() diff only makes sense for source kinds that *create* a new
    // secret (random_*, capture). For source: existing the ref is in the vault
    // by definition — the entire purpose is to push the existing secret to its
    // destinations. Skipping it would drop all destinations silently.
    if (s.source.kind !== "existing" && !ctx.force && vault.has(ref)) {
      continue;
    }

    const destinations: ResolvedDestination[] = s.destinations.map((shorthand) => {
      const r = resolveDestinationShorthand(shorthand, s.name);
      return {
        shorthand,
        template_id: r.template_id,
        template_params: r.template_params,
        domain: r.domain,
      };
    });

    out.push({
      secret: s.name,
      ref,
      source: { ...s.source } as BootstrapSource,
      destinations,
    });
  }
  return out;
}
