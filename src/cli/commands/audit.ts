// src/cli/commands/audit.ts
//
// Burst 5 §4 Task 4.6 — `secret-shuttle audit` verb.
//
// Hits POST /v1/audit/summary on the daemon and renders either a
// human-readable text summary (default) or the raw JSON body (--json).
//
// Filters:
//   --since <Ns|Nm|Nh|Nd>   Look back N seconds/minutes/hours/days.
//   --batch <id>            Show one specific batch by id (BootstrapStore-first,
//                           audit-log fallback for pruned batches).
//   --all                   ROOT ONLY — include rows for all agents. Non-root
//                           callers see the flag silently ignored by the daemon
//                           (filtered to own rows server-side).
//
// Output format: humans read text; agents pass --json. Stable JSON shape is
// documented in the route file (src/daemon/api/routes/audit-summary.ts).

import { Command } from "commander";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { ShuttleError } from "../../shared/errors.js";

// `as const` makes MULTIPLIERS' value type the union of literal numbers and
// its key type the union of literal strings. `unit as keyof typeof MULTIPLIERS`
// is safe ONLY after the type guard below; without the guard,
// noUncheckedIndexedAccess would surface `MULTIPLIERS[unit]` as
// `number | undefined`.
const MULTIPLIERS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type DurationUnit = keyof typeof MULTIPLIERS;
function isDurationUnit(s: string): s is DurationUnit {
  return s === "s" || s === "m" || s === "h" || s === "d";
}

/**
 * Parse a duration shorthand into milliseconds. Accepts `Ns`, `Nm`, `Nh`, `Nd`.
 * Throws `audit_window_invalid` for any other form. Exported for unit testing.
 */
export function parseDuration(input: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(input);
  if (m === null) {
    throw new ShuttleError(
      "audit_window_invalid",
      `Invalid --since '${input}'. Format: Ns/Nm/Nh/Nd (e.g., 5m, 1h, 7d).`,
    );
  }
  // m[1] and m[2] are string | undefined under noUncheckedIndexedAccess.
  // The regex guarantees both groups capture on match, but TS doesn't know
  // that — explicit narrowing keeps both runtime and types clean.
  const nStr = m[1];
  const unitStr = m[2];
  if (nStr === undefined || unitStr === undefined || !isDurationUnit(unitStr)) {
    throw new ShuttleError("audit_window_invalid", `Invalid --since '${input}'.`);
  }
  const n = Number.parseInt(nStr, 10);
  return n * MULTIPLIERS[unitStr];
}

// ── Response-shape types ────────────────────────────────────────────────────
// Mirrors the JSON returned by POST /v1/audit/summary. Kept loose
// (Record<string, unknown> at the leaves) because we never rely on the
// runtime shape beyond what renderText inspects defensively.

interface BatchStep {
  ok: boolean;
  ref?: string;
  source_kind?: string;
  destinations?: string[];
  destinations_ok_count?: number;
  destinations_failed_count?: number;
  error_code?: string;
}

interface BatchSummary {
  id: string;
  status?: string;
  source?: string; // "live" or "audit" — tells humans the row's provenance
  steps?: BatchStep[];
}

interface IndividualOp {
  ts?: string;
  action?: string;
  ok?: boolean;
  ref?: string;
  error_code?: string;
}

interface AuditSummaryResponse {
  ok?: boolean;
  since?: string;
  now?: string;
  summary?: {
    batches?: BatchSummary[];
    individual_ops?: IndividualOp[];
  };
  details?: { reconstructed_from?: string };
}

/**
 * Pretty-print the response for humans. Defensive against missing fields so
 * an older or newer daemon's response shape doesn't crash the formatter.
 * Exported for unit testing.
 */
export function renderText(r: AuditSummaryResponse): string {
  const lines: string[] = [];
  lines.push(`Audit summary — ${r.since ?? "all available"}`);
  lines.push("-".repeat(45));

  const batches = r.summary?.batches ?? [];
  if (batches.length === 0) {
    lines.push("(no batches in window)");
  } else {
    for (const batch of batches) {
      const status = batch.status !== undefined ? ` [${batch.status}]` : "";
      const src =
        batch.source === "audit" ? " (reconstructed from audit log)" : "";
      lines.push(`batch ${batch.id}${status}${src}`);
      const steps = batch.steps ?? [];
      for (const step of steps) {
        const mark = step.ok ? "ok " : "ERR";
        const dests = (step.destinations ?? []).join(", ");
        const sourceKind = step.source_kind ?? "(unknown)";
        const arrow = dests.length > 0 ? ` -> ${dests}` : "";
        lines.push(`  ${mark}  ${step.ref ?? "(no ref)"}  ${sourceKind}${arrow}`);
        if (!step.ok && step.error_code !== undefined) {
          lines.push(`       error: ${step.error_code}`);
        }
      }
      lines.push("");
    }
  }

  const ops = r.summary?.individual_ops ?? [];
  if (ops.length > 0) {
    lines.push("individual operations:");
    for (const op of ops) {
      const mark = op.ok === false ? "ERR" : "ok ";
      const ref = op.ref !== undefined ? ` ${op.ref}` : "";
      const err =
        op.ok === false && op.error_code !== undefined
          ? ` (${op.error_code})`
          : "";
      lines.push(`  ${mark}  ${op.action ?? "?"}${ref}${err}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function auditCommand(): Command {
  return new Command("audit")
    .description("Summarize recent secret-shuttle activity for the calling agent.")
    .option("--since <duration>", "Window (e.g., 5m, 1h, 1d, 7d).")
    .option("--batch <id>", "Show one specific batch.")
    .option("--all", "Root-only: include actions by all agents.", false)
    .option("--json", "Emit machine-readable JSON.", false)
    .action(
      async (opts: {
        since?: string;
        batch?: string;
        all?: boolean;
        json?: boolean;
      }) => {
        const body: Record<string, unknown> = {};
        if (typeof opts.since === "string") {
          body.since_ms = parseDuration(opts.since);
        }
        if (typeof opts.batch === "string") {
          body.batch_id = opts.batch;
        }
        if (opts.all === true) {
          body.include_all_actors = true;
        }

        const r = (await daemonRequest(
          "POST",
          "/v1/audit/summary",
          body,
        )) as AuditSummaryResponse;

        if (opts.json === true || !process.stdout.isTTY) {
          outputJson(ok(r as unknown as Record<string, unknown>));
          return;
        }
        process.stdout.write(renderText(r));
      },
    )
    .addHelpText(
      "after",
      `
Examples:
  # Show actions from the last 5 minutes (text):
  secret-shuttle audit --since 5m

  # Show actions from the last day as JSON:
  secret-shuttle audit --since 1d --json

  # Show one specific bootstrap batch (live or reconstructed from audit log):
  secret-shuttle audit --batch <batch-id>

  # Root-only: include actions by all agents:
  secret-shuttle audit --since 1h --all
`,
    );
}
