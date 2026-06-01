import { registry } from "../api/routes/templates.js";
import { parseSecretRef } from "../../shared/refs.js";
import type { ResolvedDestination } from "./store.js";

/**
 * Policy decisions about a bootstrap plan's production-class — both the
 * source-side (entry refs) and the destination-side (resolved destinations).
 *
 * Used by /v1/bootstrap/plan to decide the bootstrap-level approval binding's
 * environment. The bootstrap binding gate must reflect the production-class of
 * BOTH the plan entries' source refs AND the resolved destinations, because the
 * inner per-template approval (in runTemplateCore) is bypassed when bootstrap
 * calls it with bootstrapAuthority — so the OUTER binding is the only chance
 * to require a human click.
 *
 * Per-template treatment for destination-side:
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
  // browser_inject destinations interact directly with the live browser, which
  // is always considered production-class (fail-closed).
  if (dest.kind !== "template") {
    return true;
  }
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

/**
 * Returns true if any PlanEntry has source.kind === "capture".
 *
 * Used by /v1/bootstrap/plan to force a production-class binding (i.e. require
 * a human approval click) whenever the plan contains a capture step, regardless
 * of --environment or destination class. Capture flows are inherently
 * interactive — they require the user to navigate a browser tab to the source
 * site so the daemon can read the secret from the visible page. The
 * dev-synth-execute path has no UI surface for this click, so a capture-only
 * dev plan would inline-execute and hang waiting for a capture that the user
 * has no way to trigger. Routing it through the approval gate gives the user
 * an explicit /continue step and the hub UI a place to render the capture
 * coordinator card (C14).
 */
export function planRequiresCapture(
  plan: ReadonlyArray<{ source: { kind: string } }>,
): boolean {
  return plan.some(
    (entry) => entry.source.kind === "capture" || entry.source.kind === "human_paste",
  );
}

/**
 * Returns true if any PlanEntry's ref resolves to the production environment.
 *
 * Used by /v1/bootstrap/plan to elevate the bootstrap binding's approval gate
 * when ANY plan entry sources a production secret. This is the third gate
 * condition (alongside canonicalEnvironment(request) and
 * planHasProductionDestination) needed to close the bootstrap-authority bypass.
 *
 * Why this is needed:
 * - For source: existing entries, the ref comes verbatim from yml. Neither the
 *   request flag nor destination class reflects the secret's actual environment.
 * - The inner runTemplateCore would normally elevate the per-template approval
 *   to production when secret.environment === "production" (templates.ts:148),
 *   but bootstrap bypasses the inner requireApprovals via bootstrapAuthority.
 *   The OUTER bootstrap binding is the only remaining gate.
 *
 * Unparseable refs fail closed (return true). A malformed ref in the plan is
 * itself a sign that something is wrong; requiring approval is the safer default.
 */
export function planHasProductionSource(
  plan: ReadonlyArray<{ ref: string }>,
): boolean {
  return plan.some((entry) => {
    try {
      return parseSecretRef(entry.ref).environment === "production";
    } catch {
      return true; // unparseable ref → fail closed
    }
  });
}
