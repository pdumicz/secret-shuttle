/** Canonicalize a host for recipe lookup/equality. Trim whitespace, lowercase, strip
 *  trailing dot. Used as the SINGLE source of truth for host normalization across the
 *  recipe registry and page-state revalidation so a divergence cannot silently produce
 *  mismatched lookup vs. equality keys. */
export function canonicalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}
