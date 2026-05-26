import { registry } from "../api/routes/templates.js";
import type { ResolvedDestination } from "./store.js";

/**
 * Returns true if a bootstrap destination is "production-class" — i.e., its
 * push could write to a production-tier target.
 *
 * Used by /v1/bootstrap/plan to decide the bootstrap-level approval binding's
 * environment. The bootstrap binding gate must reflect the destinations'
 * production-class because the inner per-template approval (in runTemplateCore)
 * is bypassed when bootstrap calls it with bootstrapAuthority — so the OUTER
 * binding is the only chance to require a human click.
 *
 * Per-template treatment:
 * - vercel-env-add: destinationEnvironment returns environment param
 *   (production/preview/development). "production" → prod-class.
 * - cloudflare-secret-put: destinationEnvironment returns env param (default
 *   "production" when env is unset/empty). "production" → prod-class.
 * - github-actions-secret-set: secrets affect CI which can deploy anywhere.
 *   ALWAYS prod-class regardless of repo.
 * - supabase-edge-secret-set: edge function secrets affect production traffic.
 *   ALWAYS prod-class regardless of project_ref.
 * - Unknown template (registry miss): fail closed → prod-class.
 * - Template with no destinationEnvironment: fail closed → prod-class.
 */
export function isDestinationProductionClass(dest: ResolvedDestination): boolean {
  // github-actions and supabase: inherently CI/production-affecting regardless of
  // what their destinationEnvironment returns (which is repo/project_ref, not env).
  if (
    dest.template_id === "github-actions-secret-set" ||
    dest.template_id === "supabase-edge-secret-set"
  ) {
    return true;
  }
  let tpl;
  try {
    tpl = registry.get(dest.template_id);
  } catch {
    return true; // unknown template → fail closed
  }
  if (tpl.destinationEnvironment === undefined) {
    return true; // template has no env concept → fail closed
  }
  return tpl.destinationEnvironment(dest.template_params) === "production";
}

export function planHasProductionDestination(
  plan: ReadonlyArray<{ destinations: ReadonlyArray<ResolvedDestination> }>,
): boolean {
  return plan.some((entry) => entry.destinations.some(isDestinationProductionClass));
}
