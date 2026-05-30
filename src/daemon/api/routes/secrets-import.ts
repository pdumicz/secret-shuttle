import type { IncomingMessage } from "node:http";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { asObject, optApprovalIds, optBool, optString } from "../validate.js";
import { canonicalEnvironment, buildSecretRef } from "../../../shared/refs.js";
import { SecretValue } from "../../../vault/secret-value.js";

interface ImportEntry {
  key: string;
  value: SecretValue;
}

interface RouteRegistrar {
  addRoute: (
    method: "POST",
    path: string,
    handler: (req: IncomingMessage, body: unknown) => Promise<unknown>,
  ) => void;
}

export function registerSecretsImportRoute(
  server: RouteRegistrar,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/secrets/import", async (_req, body) => {
    services.lock.assertUnlocked();

    const o = asObject(body);
    const approvalIds = optApprovalIds(o);

    // Parse entries array
    const entriesRaw = o["entries"];
    if (!Array.isArray(entriesRaw)) {
      throw new ShuttleError("bad_request", "entries: must be an array");
    }
    // Burst 7 §2 (5q): wrap each entry value into a SecretValue at the PARSE
    // loop and drop the raw parsed string from the request-body object graph so
    // it is GC-eligible before the (possibly long) production approval gate.
    // This guard try/catch is DISTINCT from — and precedes — the route-level try
    // below: a later malformed entry would otherwise leak every SecretValue
    // already wrapped from a prior valid entry (the route-level catch starts
    // AFTER this loop, and it writes a failure audit that must NOT fire for
    // these pre-approval parse errors). `entries` is declared before the guard
    // so both the catch and the downstream store loop see it.
    const entries: ImportEntry[] = [];
    try {
      for (const e of entriesRaw) {
        const eo = asObject(e);
        const key = optString(eo, "key");
        const value = optString(eo, "value");
        if (key === undefined) throw new ShuttleError("missing_param", "entries[].key required");
        if (value === undefined) throw new ShuttleError("missing_param", "entries[].value required");
        entries.push({ key, value: SecretValue.fromUtf8(value) });
        // Drop the raw parsed value string from the request-body object graph.
        // (JS strings can't be zeroed; the win is prompt unreachability — the
        // same Tier-A bound as the vault read transient.)
        if (e !== null && typeof e === "object") delete (e as Record<string, unknown>)["value"];
      }
    } catch (err) {
      // A later entry threw during parse/validation AFTER earlier entries were
      // already wrapped into live SecretValues — the route-level catch below
      // does not cover this pre-try region, so dispose here. (dispose() is
      // idempotent; this only ever holds not-yet-stored values.)
      for (const entry of entries) entry.value.dispose();
      throw err;
    }

    const source = optString(o, "source") ?? "local";
    const environmentRaw = optString(o, "environment") ?? "development";
    const environment = canonicalEnvironment(environmentRaw);
    const force = optBool(o, "force") ?? false;
    const skipExisting = optBool(o, "skip_existing") ?? false;
    const sessionId = optString(o, "session_id");
    const waitForApproval = optBool(o, "wait_for_approval") ?? true;

    // Hoisted for audit catch-block access (same pattern as secrets-delete).
    let grant: ApprovalGrant | undefined;

    try {
      // Production env requires a single batch approval covering the whole import.
      if (environment === "production") {
        const binding: ApprovalBinding = {
          action: "import",
          ref: null,
          environment: "production",
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: {
            source,
            environment,
            keys: entries.map((e) => e.key).join(","),
          },
          allowed_domains: [],
        };
        const grants = await requireApprovals({
          store: services.approvals,
          bindings: [binding],
          daemonPort: daemonPortRef(),
          sessionStore: services.sessionStore,
          openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(approvalIds !== undefined ? { approvalIdsFromClient: approvalIds } : {}),
          ...(waitForApproval === false ? { waitMs: 0 } : {}),
        });
        grant = grants[0];
      }

      // Walk entries and store via vault.
      let imported = 0;
      const skipped_existing: string[] = [];
      const refs: string[] = [];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        // Try to get existing secret. upsertSecret will throw secret_exists if
        // the ref exists and force=false — we need to check ourselves for skip_existing.
        const candidateRef = buildSecretRef(source, environment, entry.key);
        let existingRef: string | undefined;
        try {
          // Burst 7 §2 (5q): existence check reads only .ref (metadata) — route
          // to the no-value inspect(). It throws secret_not_found for missing /
          // soft-deleted refs, same as before.
          const existing = await services.vault.inspect(candidateRef);
          existingRef = existing.ref;
        } catch {
          // Does not exist — proceed with upsert
        }

        if (existingRef !== undefined) {
          if (skipExisting) {
            // Burst 7 §2 (5q): skipped — not handed to the vault, so the route
            // disposes its SecretValue here before continuing.
            entry.value.dispose();
            skipped_existing.push(entry.key);
            continue;
          }
          if (!force) {
            await writeDaemonAudit({
              action: "import",
              ok: false,
              ref: existingRef,
              environment,
              error_code: "secret_exists",
              ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
            });
            // Dispose THIS entry + all remaining unconsumed entries before the
            // throw (the entries before `i` were already consumed by the vault,
            // which disposed them; dispose() is idempotent regardless).
            for (let j = i; j < entries.length; j++) entries[j]!.value.dispose();
            throw new ShuttleError(
              "secret_exists",
              `Ref already exists: ${existingRef}. Use --force to overwrite or --skip-existing to continue past.`,
            );
          }
          // force=true — fall through to upsert (overwrite)
        }

        const meta = await services.vault.upsertSecret({
          name: entry.key,
          environment,
          source,
          // Already a SecretValue — the vault OWNS + disposes it (Burst 7 §2).
          value: entry.value,
          allowedDomains: [],
          // Pass force:true only when the ref already exists; upsertSecret
          // treats undefined the same as false (throws secret_exists on dup).
          ...(existingRef !== undefined ? { force: true } : {}),
        });
        refs.push(meta.ref);
        imported += 1;
        await writeDaemonAudit({
          action: "import",
          ok: true,
          ref: meta.ref,
          environment: meta.environment,
          ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
        });
      }

      return { ok: true, imported, skipped: 0, refs, skipped_existing };
    } catch (err) {
      // Burst 7 §2 (5q): defensively dispose every entry's SecretValue. dispose()
      // is idempotent, so vault-consumed + skipped entries (already disposed) are
      // unaffected; this scrubs the approval-denied-before-loop case, where
      // requireApprovals throws BEFORE the entry loop so ALL entries are unconsumed.
      for (const entry of entries) entry.value.dispose();
      // Only write a top-level failure audit if it is NOT a secret_exists we
      // already audited above (which re-throws immediately after the audit).
      if (
        !(err instanceof ShuttleError && err.code === "secret_exists")
      ) {
        await writeDaemonAudit({
          action: "import",
          ok: false,
          environment,
          error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
          ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
        });
      }
      throw err;
    }
  });
}
