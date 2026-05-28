// src/daemon/api/routes/audit-summary.ts
//
// Burst 5 §4 Task 4.6 — POST /v1/audit/summary
//
// Returns a structured summary of recent activity for the calling agent.
//
// Owner-scoping:
//   - Default (no include_all_actors): rows where actor_agent_id === caller.
//   - include_all_actors=true AND caller is root: rows for ALL agents.
//   - include_all_actors=true AND caller is NOT root: silently filters to own
//     rows (the flag is ignored, not rejected — keeps the CLI surface uniform).
//
// Non-disclosure: when --batch <id> is supplied and ALL matching rows belong
// to another agent (or the batch simply doesn't exist), the route throws
// `audit_batch_not_found` (same code for both "exists but not yours" and
// "doesn't exist at all") so existence is never disclosed cross-owner.
//
// Lookup order for --batch:
//   1. BootstrapStore.get(id) — fast path for live (non-pruned) batches.
//   2. Audit-log fallback — reconstruct from bootstrap_step rows. Returned
//      payload sets summary.batches[0].source = "audit" and details.reconstructed_from = "audit"
//      so consumers can detect the fallback case.

import { readFile } from "node:fs/promises";
import { ShuttleError } from "../../../shared/errors.js";
import { getCurrentAgentId, getAuthContext } from "../../auth/auth-context.js";
import { getShuttlePaths } from "../../../shared/config.js";
import type { BootstrapStore, BatchState } from "../../bootstrap/store.js";
import type { DaemonServer } from "../../server.js";
import { asObject, optBool, optString } from "../validate.js";

// ── Audit-row narrowing ────────────────────────────────────────────────────
// We read JSONL audit rows as `unknown` and narrow defensively. The shape
// MUST match what writeDaemonAudit serialises (src/daemon/audit.ts):
// every row carries `ts` + `actor_agent_id` + `action` at minimum, with
// optional batch_id / source_kind / destination_shorthands / *_count etc.

interface AuditRow {
  ts: string;
  action: string;
  ok: boolean;
  actor_agent_id: string;
  ref?: string;
  batch_id?: string;
  source_kind?: string;
  destination_shorthands?: string[];
  destinations_ok_count?: number;
  destinations_failed_count?: number;
  error_code?: string;
}

function isAuditRow(v: unknown): v is AuditRow {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["ts"] === "string" &&
    typeof o["action"] === "string" &&
    typeof o["ok"] === "boolean" &&
    typeof o["actor_agent_id"] === "string"
  );
}

// ── Response-shape types ───────────────────────────────────────────────────
// Mirrors what the CLI renderer reads (src/cli/commands/audit.ts). The
// `source` discriminator on a batch tells consumers whether the data came
// from a live BootstrapStore record or was reconstructed from audit-log rows.

interface SerializedStep {
  // P2-3: `status` discriminates ok / failed / pending. We keep `ok` as a
  // legacy boolean compat field — true when status==="ok", false otherwise —
  // so consumers that haven't been updated (older CLI versions, JSON readers
  // outside this repo) still see something coherent. New consumers MUST
  // branch on `status` to render pending (un-attempted) steps distinctly
  // from failed steps.
  status: "ok" | "failed" | "pending";
  ok: boolean;
  ref?: string;
  source_kind?: string;
  destinations?: string[];
  destinations_ok_count?: number;
  destinations_failed_count?: number;
  error_code?: string;
}

interface SerializedBatch {
  id: string;
  source: "live" | "audit";
  status?: string;
  steps: SerializedStep[];
}

interface SerializedIndividualOp {
  ts: string;
  action: string;
  ok: boolean;
  ref?: string;
  error_code?: string;
}

interface AuditSummary {
  batches: SerializedBatch[];
  individual_ops: SerializedIndividualOp[];
}

// Burst-5 §4 spec §4 "Output (JSON format)": the route always responds with
// `summary`. /v1/audit/summary stamps `since`+`now` on the --since path so
// agents can correlate the window; the --batch path returns a single batch.

interface SummaryResponse {
  summary: AuditSummary;
  since?: string;
  now?: string;
  details?: { reconstructed_from: "audit" };
}

// ── Action classification ──────────────────────────────────────────────────
// Audit rows for "system plumbing" actions (token mint, daemon rotation,
// machine-id reset) are noise in a user-facing summary. The default filter
// drops them; --batch lookups are unaffected (those only touch bootstrap_step
// rows via batch_id matching).

const NON_USER_FACING_ACTIONS = new Set<string>([
  "tokens_mint",
  "daemon_rotate",
  "daemon_reset_machine_id",
]);

function isUserFacingAction(action: string): boolean {
  return !NON_USER_FACING_ACTIONS.has(action);
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function readAuditRows(): Promise<AuditRow[]> {
  const paths = getShuttlePaths();
  let content: string;
  try {
    content = await readFile(paths.auditLogPath, "utf8");
  } catch {
    return [];
  }
  const out: AuditRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines silently — the audit log is append-only and
      // we never want a single bad row to break the summary view.
      continue;
    }
    if (isAuditRow(parsed)) out.push(parsed);
  }
  return out;
}

function serializeBatchFromState(state: BatchState): SerializedBatch {
  const steps: SerializedStep[] = [];
  for (const entry of state.plan) {
    const result = state.step_results[entry.secret];
    if (result === undefined) {
      // P2-3 fix: step not yet attempted → emit status="pending" so the CLI
      // can render it distinctly from a failure. Pre-fix this came through as
      // `ok: false`, which the CLI rendered as "ERR" — exactly the same as a
      // real failure, hiding the fact that the executor never tried this
      // step. The `ok: false` legacy field is kept for back-compat with
      // older readers (a not-yet-attempted step is also not-yet-ok).
      const pending: SerializedStep = {
        status: "pending",
        ok: false,
        ref: entry.ref,
        source_kind: entry.source.kind,
        destinations: entry.destinations.map((d) => d.shorthand),
      };
      steps.push(pending);
      continue;
    }
    const destsPushed = result.destinations_pushed ?? [];
    const okCount = destsPushed.filter((d) => d.ok).length;
    const failedCount = destsPushed.filter((d) => !d.ok).length;
    const step: SerializedStep = {
      status: result.ok ? "ok" : "failed",
      ok: result.ok,
      ref: result.ref ?? entry.ref,
      source_kind: entry.source.kind,
      destinations: entry.destinations.map((d) => d.shorthand),
      destinations_ok_count: okCount,
      destinations_failed_count: failedCount,
      ...(result.error_code !== undefined ? { error_code: result.error_code } : {}),
    };
    steps.push(step);
  }
  return {
    id: state.batch_id,
    source: "live",
    status: state.status,
    steps,
  };
}

function reconstructBatchFromRows(rows: AuditRow[]): SerializedBatch {
  // Group by ref within the batch and keep only the LAST row per ref (the
  // most recent execution outcome wins — matches what the live BatchState
  // would surface). Falls back to "<unknown>" if a row has no ref.
  const byRef = new Map<string, AuditRow>();
  for (const r of rows) {
    if (r.action !== "bootstrap_step") continue;
    const key = r.ref ?? "<unknown>";
    byRef.set(key, r);
  }
  const steps: SerializedStep[] = [];
  for (const row of byRef.values()) {
    // Audit-log fallback: every row here corresponds to a bootstrap_step that
    // actually ran (writeDaemonAudit only emits these on attempt), so status
    // is always ok / failed — never pending. Pending steps live only in
    // BatchState (the live-source path above).
    const step: SerializedStep = {
      status: row.ok ? "ok" : "failed",
      ok: row.ok,
      ...(row.ref !== undefined ? { ref: row.ref } : {}),
      ...(row.source_kind !== undefined ? { source_kind: row.source_kind } : {}),
      ...(row.destination_shorthands !== undefined
        ? { destinations: row.destination_shorthands }
        : {}),
      ...(row.destinations_ok_count !== undefined
        ? { destinations_ok_count: row.destinations_ok_count }
        : {}),
      ...(row.destinations_failed_count !== undefined
        ? { destinations_failed_count: row.destinations_failed_count }
        : {}),
      ...(row.error_code !== undefined ? { error_code: row.error_code } : {}),
    };
    steps.push(step);
  }
  // rows[0] is the type-asserted first; the caller guarantees rows.length>=1.
  const first = rows[0];
  if (first === undefined) {
    // Defensive: should never happen — callers pre-filter.
    throw new ShuttleError(
      "internal_error",
      "reconstructBatchFromRows called with empty rows.",
    );
  }
  return {
    id: first.batch_id ?? "<unknown>",
    source: "audit",
    steps,
  };
}

function groupByBatchId(rows: AuditRow[]): SerializedBatch[] {
  const buckets = new Map<string, AuditRow[]>();
  for (const r of rows) {
    if (r.batch_id === undefined) continue;
    let bucket = buckets.get(r.batch_id);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(r.batch_id, bucket);
    }
    bucket.push(r);
  }
  const out: SerializedBatch[] = [];
  for (const bucket of buckets.values()) {
    out.push(reconstructBatchFromRows(bucket));
  }
  return out;
}

// ── Route ──────────────────────────────────────────────────────────────────

export function registerAuditSummaryRoute(
  server: DaemonServer,
  deps: { bootstrapStore: BootstrapStore },
): void {
  server.addRoute("POST", "/v1/audit/summary", async (_req, raw) => {
    const o = asObject(raw);

    const actorAgent = getCurrentAgentId();
    const callerIsRoot = getAuthContext()?.isRoot === true;
    // include_all_actors=true is honoured ONLY for root; non-root sees the
    // flag silently ignored. (Mirrors what /v1/approvals/sessions does for
    // its own list endpoint — same defence in depth.)
    const includeAll =
      optBool(o, "include_all_actors") === true && callerIsRoot;

    // since_ms is a number (in milliseconds). The CLI rejects unparseable
    // forms client-side, so by the time we land here we expect either
    // undefined or a non-negative number. Non-numbers fall through to "all".
    const sinceMsRaw = o["since_ms"];
    const sinceMs =
      typeof sinceMsRaw === "number" && Number.isFinite(sinceMsRaw) && sinceMsRaw >= 0
        ? sinceMsRaw
        : null;
    const batchIdReq = optString(o, "batch_id") ?? null;

    // ── --batch path ──
    if (batchIdReq !== null) {
      const live = await deps.bootstrapStore.get(batchIdReq);
      if (live !== null) {
        // Owner-gate: non-root callers can only see their own batches.
        // Throw `audit_batch_not_found` (NOT `forbidden`) to preserve
        // non-disclosure: existence of a cross-owner batch must not leak.
        if (!includeAll && !callerIsRoot && live.owner_agent_id !== actorAgent) {
          throw new ShuttleError(
            "audit_batch_not_found",
            `Batch ${batchIdReq} not found.`,
          );
        }
        const response: SummaryResponse = {
          summary: {
            batches: [serializeBatchFromState(live)],
            individual_ops: [],
          },
        };
        return response;
      }

      // BootstrapStore miss — fall back to reconstructing from audit log.
      const allRows = await readAuditRows();
      const matching = allRows.filter((r) => r.batch_id === batchIdReq);
      // Non-disclosure: when zero rows match OR no matching row belongs to
      // the caller (root sees everything), return the same not_found code.
      const callerHasOwnership =
        includeAll ||
        callerIsRoot ||
        matching.some((r) => r.actor_agent_id === actorAgent);
      if (matching.length === 0 || !callerHasOwnership) {
        throw new ShuttleError(
          "audit_batch_not_found",
          `Batch ${batchIdReq} not found.`,
        );
      }
      const scopedRows =
        includeAll || callerIsRoot
          ? matching
          : matching.filter((r) => r.actor_agent_id === actorAgent);
      const response: SummaryResponse = {
        summary: {
          batches: [reconstructBatchFromRows(scopedRows)],
          individual_ops: [],
        },
        details: { reconstructed_from: "audit" },
      };
      return response;
    }

    // ── --since path (or "all available" when since_ms is omitted) ──
    const cutoff = sinceMs !== null ? Date.now() - sinceMs : 0;
    const allRows = await readAuditRows();
    const windowed = allRows.filter((r) => {
      const t = Date.parse(r.ts);
      if (Number.isNaN(t)) return false;
      return t >= cutoff;
    });
    const scoped = includeAll
      ? windowed
      : windowed.filter((r) => r.actor_agent_id === actorAgent);

    const batches = groupByBatchId(scoped);
    const individualOps: SerializedIndividualOp[] = scoped
      .filter((r) => r.batch_id === undefined && isUserFacingAction(r.action))
      .map((r) => ({
        ts: r.ts,
        action: r.action,
        ok: r.ok,
        ...(r.ref !== undefined ? { ref: r.ref } : {}),
        ...(r.error_code !== undefined ? { error_code: r.error_code } : {}),
      }));

    const response: SummaryResponse = {
      summary: { batches, individual_ops: individualOps },
      since:
        sinceMs !== null ? `${Math.round(sinceMs / 60_000)}m` : "all available",
      now: new Date().toISOString(),
    };
    return response;
  });
}
