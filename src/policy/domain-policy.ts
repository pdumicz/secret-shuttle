import { ShuttleError } from "../shared/errors.js";

export function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  if (trimmed === "") {
    return "";
  }

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return trimmed.replace(/^\*\./, "*.").replace(/\/.*$/, "");
  }
}

export function domainMatches(currentDomain: string, allowedDomain: string): boolean {
  const current = normalizeDomain(currentDomain);
  const allowed = normalizeDomain(allowedDomain);

  if (allowed.startsWith("*.")) {
    const suffix = allowed.slice(1);
    return current.endsWith(suffix) && current.length > suffix.length;
  }

  return current === allowed || current.endsWith(`.${allowed}`);
}

export function assertDomainAllowed(
  currentDomain: string,
  allowedDomains: string[],
  action: "capture" | "inject" | "compare",
): void {
  const current = normalizeDomain(currentDomain);
  if (current === "") {
    throw new ShuttleError("unknown_browser_domain", "Secret Shuttle could not determine the current browser domain.");
  }

  if (allowedDomains.length === 0) {
    return;
  }

  if (!allowedDomains.some((allowed) => domainMatches(current, allowed))) {
    throw new ShuttleError(
      "domain_not_allowed",
      `Refused to ${action} on ${current}. Allowed domains: ${allowedDomains.join(", ")}.`,
    );
  }
}

export function assertProvidedDomainMatchesCurrent(providedDomain: string | undefined, currentDomain: string): void {
  if (providedDomain === undefined || providedDomain.trim() === "") {
    return;
  }

  if (!domainMatches(currentDomain, providedDomain)) {
    throw new ShuttleError(
      "domain_mismatch",
      `Current browser domain ${normalizeDomain(currentDomain)} does not match requested domain ${normalizeDomain(providedDomain)}.`,
    );
  }
}
