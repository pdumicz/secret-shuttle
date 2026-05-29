import { fileExists, getShuttlePaths } from "../../../shared/config.js";
import { getCurrentAgentId } from "../../auth/auth-context.js";
import type { SessionGrant } from "../../approvals/session.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

/**
 * Build a single-line, human-readable summary of a granted session's pattern.
 * Surfaced on /v1/health.active_sessions[].pattern_summary so `secret-shuttle
 * status` (and any JSON consumer of report.health) can show the user which
 * sessions are live without re-deriving the shape client-side.
 *
 * Shape: "<action> on <ref_glob>[ via <template_id>][ (k=v, k=v)]"
 *
 * Strict-TS notes:
 * - s.actions is non-empty per assertSessionPatternValid, but the SessionGrant
 *   type can't encode that — under noUncheckedIndexedAccess [0] is T|undefined,
 *   so we coalesce defensively.
 * - s.template_ids is optional; only emit the " via ..." suffix when the first
 *   entry exists.
 * - required_params is Record<string,string> when present; Object.entries is
 *   safe.
 */
function summarizePattern(s: SessionGrant): string {
  const action = s.actions[0] ?? "unknown";
  const refish = s.ref_glob || "*";
  const firstTemplate = s.template_ids?.[0];
  const tmpl = firstTemplate !== undefined ? ` via ${firstTemplate}` : "";
  const params = s.required_params !== undefined
    ? ` (${Object.entries(s.required_params).map(([k, v]) => `${k}=${v}`).join(", ")})`
    : "";
  return `${action} on ${refish}${tmpl}${params}`;
}

export function registerHealth(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("GET", "/v1/health", async () => {
    const paths = getShuttlePaths();
    const unlocked = services.lock.isUnlocked();
    let policyWarnings: string[] | null = null;
    if (unlocked) {
      const secrets = await services.vault.list();
      policyWarnings = secrets
        .filter((s) => s.environment === "production" && s.allowed_domains.length === 0)
        .map((s) => `${s.ref} is production but has no allowed domains (not injectable; re-create with --allow-domain)`);
    }
    const browserStarted = services.browser !== null;
    const proxyActive = services.cdpProxy !== null;
    // After Phases 1-3, this daemon build always supports inject-submit/reveal-capture
    // handles. Encoded as a literal so consumers can branch on capability.
    const handlesSupported = true;
    const marksActive = services.handles.list().length;

    // Burst 5 §2b Task 2b.7: surface the caller's owner-scoped active
    // sessions on the route the CLI actually calls (status.ts uses
    // /v1/health, not /v1/status). Owner scoping is strict — only
    // sessions whose owner_agent_id matches the caller's derived agent
    // id show up. Root and the synthetic "daemon" id are explicitly
    // excluded: they are never owners of agent-minted sessions, so any
    // match would be a stamping bug.
    const currentAgent = getCurrentAgentId();
    const ownerScoped = currentAgent !== "root" && currentAgent !== "daemon";
    const now = Date.now();
    const active_sessions = ownerScoped
      ? services.sessionStore
          .list()
          .filter((s) => s.owner_agent_id === currentAgent)
          .filter((s) => s.status === "granted")
          .filter((s) => s.expires_at > now)
          .map((s) => ({
            id: s.id,
            pattern_summary: summarizePattern(s),
            expires_at: new Date(s.expires_at).toISOString(),
            minutes_remaining: Math.round((s.expires_at - now) / 60_000),
          }))
      : [];

    return {
      daemon: true,
      unlocked,
      blind_mode: services.blind.current(),
      browser_started: browserStarted,
      proxy_active: proxyActive,
      vault: {
        envelope_present: await fileExists(paths.envelopePath),
        legacy_key_present: await fileExists(paths.keyPath),
      },
      policy_warnings: policyWarnings,
      agentic_browser: {
        available: browserStarted && proxyActive && handlesSupported,
        browser_started: browserStarted,
        proxy_active: proxyActive,
        handles_supported: handlesSupported,
        marks_active: marksActive,
      },
      active_sessions,
      version: 2,
    };
  });
}
