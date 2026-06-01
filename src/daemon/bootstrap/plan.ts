import type { BootstrapPlan } from "../../cli/bootstrap/yml.js";
import { resolveDestinationShorthand } from "../../cli/bootstrap/destination-shorthand.js";
import type { PlanEntry, ResolvedDestination, BootstrapSource } from "./store.js";
import { buildSecretRef, canonicalEnvironment } from "../../shared/refs.js";
import { recipeRegistry, type RecipeRegistry } from "../recipes/registry.js";
import { canonicalHost } from "../recipes/host.js";

interface PlanContext {
  source: string;
  environment: string;
  force: boolean;
}

interface VaultLike {
  has(ref: string): boolean;
}

export interface PlanSelection {
  recipes?: RecipeRegistry;
  /** True iff the vendor CLI for this template_id is usable. Default () => true. */
  isCliConfigured?: (templateId: string) => boolean;
  /** §200 coverage gate. Default () => false. */
  coversDestination?: (recipeHost: string, domain: string, shorthand: string) => boolean;
}

export function computeBootstrapPlan(
  parsed: BootstrapPlan,
  vault: VaultLike,
  ctx: PlanContext,
  selection: PlanSelection = {},
): PlanEntry[] {
  const recipes = selection.recipes ?? recipeRegistry;
  const isCliConfigured = selection.isCliConfigured ?? (() => true);
  const coversDestination = selection.coversDestination ?? (() => false);

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
      const injectRecipe = recipes.getInject(canonicalHost(r.domain));
      if (
        injectRecipe !== undefined &&
        !isCliConfigured(r.template_id) &&
        coversDestination(injectRecipe.host, r.domain, shorthand)
      ) {
        return { kind: "browser_inject" as const, recipe_host: injectRecipe.host, shorthand, domain: r.domain };
      }
      return {
        kind: "template" as const,
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
      // Only set force when the entry would have been filtered out without
      // --force. For source: existing, force is irrelevant (no generation runs).
      // For sources that create a secret: force=true only when the ref already
      // exists in the vault and the user passed --force; otherwise omit.
      ...(s.source.kind !== "existing" && ctx.force && vault.has(ref) ? { force: true } : {}),
    });
  }
  return out;
}
