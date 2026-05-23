import { canonicalAction, globToRegExp, type SessionPattern } from "./session.js";
import type { ApprovalBinding } from "./store.js";

export function matchesSessionPattern(
  binding: ApprovalBinding,
  pattern: SessionPattern,
): boolean {
  const canonical = canonicalAction(binding.action);
  if (canonical === null) return false; // includes secrets_delete, secrets_rotate, anything unknown
  if (!pattern.actions.includes(canonical)) return false;

  switch (canonical) {
    case "template-run":
      return templateRunMatches(binding, pattern);
    case "inject-submit":
      return injectSubmitMatches(binding, pattern);
    case "reveal-capture":
      return revealCaptureMatches(binding, pattern);
    case "secrets-set":
      return secretsSetMatches(binding, pattern);
  }
}

/**
 * template-run: ref + template_id. NO destination_domain check because the
 * template_run route currently sets binding.destination_domain = null
 * (see src/daemon/api/routes/templates.ts:91) — a destination_domains
 * constraint here would never match. The security boundary for template
 * sessions is template_ids; templates have implicit destinations encoded
 * by the template_id (e.g. vercel-env-add → vercel.com).
 */
function templateRunMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  if (pattern.ref_glob.length > 0) {
    if (binding.ref === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(binding.ref)) return false;
  }
  // template_ids is REQUIRED non-empty by assertSessionPatternValid for
  // template-run patterns; checking length > 0 is defense in depth.
  if (pattern.template_ids === undefined || pattern.template_ids.length === 0) return false;
  if (binding.template_id === null) return false;
  if (!pattern.template_ids.includes(binding.template_id)) return false;
  return true;
}

/**
 * inject-submit: ref + destination_domain. Both are populated by the route.
 */
function injectSubmitMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  if (pattern.ref_glob.length > 0) {
    if (binding.ref === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(binding.ref)) return false;
  }
  // destination_domains is REQUIRED non-empty by assertSessionPatternValid.
  if (pattern.destination_domains.length === 0) return false;
  if (binding.destination_domain === null) return false;
  if (!pattern.destination_domains.includes(binding.destination_domain)) return false;
  return true;
}

/**
 * reveal-capture: PLANNED_REF (not binding.ref — see
 * src/daemon/api/routes/reveal-capture.ts:148) + destination_domain.
 * The reveal-capture flow MINTS a new secret; binding.ref is null until
 * after the operation completes.
 */
function revealCaptureMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  const plannedRef = binding.planned_ref ?? null;
  if (pattern.ref_glob.length > 0) {
    if (plannedRef === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(plannedRef)) return false;
  }
  if (pattern.destination_domains.length === 0) return false;
  if (binding.destination_domain === null) return false;
  if (!pattern.destination_domains.includes(binding.destination_domain)) return false;
  return true;
}

/**
 * secrets-set: planned_ref + allowed_domains ⊆ pattern.destination_domains
 * + allowed_actions ⊆ pattern.allowed_actions.
 * The agent cannot widen what the human approved on either axis.
 */
function secretsSetMatches(binding: ApprovalBinding, pattern: SessionPattern): boolean {
  const plannedRef = binding.planned_ref ?? null;
  if (pattern.ref_glob.length > 0) {
    if (plannedRef === null) return false;
    if (!globToRegExp(pattern.ref_glob).test(plannedRef)) return false;
  }
  // Both REQUIRED non-empty by assertSessionPatternValid. Defense-in-depth: if
  // a pattern slipped past validation without one of these, refuse outright
  // rather than silently auto-approve a too-wide secret.
  if (pattern.destination_domains.length === 0) return false;
  if (pattern.allowed_actions === undefined || pattern.allowed_actions.length === 0) return false;
  const allowedDomains = binding.allowed_domains ?? [];
  const domainPatternSet = new Set(pattern.destination_domains);
  for (const d of allowedDomains) {
    if (!domainPatternSet.has(d)) return false; // binding widens the approved domains
  }
  // Defense-in-depth: refuse if the binding doesn't carry an explicit action
  // scope at all. The generate route populates binding.allowed_actions before
  // requireApproval, so missing-undefined here means the binding came from
  // somewhere that doesn't carry the contract; don't session-approve. An
  // explicit empty array ([]) is allowed — that's a deliberately narrow scope.
  // null is treated the same as undefined — both mean "no explicit scope".
  if (binding.allowed_actions === undefined || binding.allowed_actions === null) return false;
  const actionsPatternSet = new Set(pattern.allowed_actions);
  for (const a of binding.allowed_actions) {
    if (!actionsPatternSet.has(a)) return false; // binding widens the approved actions
  }
  return true;
}
