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
  /** True iff the vendor CLI for this template_id is usable. Default () => true
   *  preserves today's CLI-always behavior (never auto-picks browser_inject). */
  isCliConfigured?: (templateId: string) => boolean;
}

export function computeBootstrapPlan(
  parsed: BootstrapPlan,
  vault: VaultLike,
  ctx: PlanContext,
  selection: PlanSelection = {},
): PlanEntry[] {
  const recipes = selection.recipes ?? recipeRegistry;
  const isCliConfigured = selection.isCliConfigured ?? (() => true);

  const out: PlanEntry[] = [];
  for (const s of parsed.secrets) {
    const ref =
      s.source.kind === "existing"
        ? s.source.ref
        : buildSecretRef(ctx.source, canonicalEnvironment(ctx.environment), s.name);

    if (s.source.kind !== "existing" && !ctx.force && vault.has(ref)) {
      continue;
    }

    const destinations: ResolvedDestination[] = s.destinations.map((entry) => {
      const r = resolveDestinationShorthand(entry.shorthand, s.name);
      const injectRecipe = recipes.getInject(canonicalHost(r.domain));
      if (injectRecipe !== undefined && !isCliConfigured(r.template_id)) {
        return {
          kind: "browser_inject" as const,
          recipe_host: injectRecipe.host,
          shorthand: entry.shorthand,
          domain: r.domain,
          // OMIT url_params when undefined (§3 rule). Spread-on-defined idiom.
          ...(entry.url_params !== undefined ? { url_params: entry.url_params } : {}),
        };
      }
      return {
        kind: "template" as const,
        shorthand: entry.shorthand,
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
      ...(s.source.kind !== "existing" && ctx.force && vault.has(ref) ? { force: true } : {}),
    });
  }
  return out;
}
