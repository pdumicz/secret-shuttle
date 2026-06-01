/**
 * Pure function: determines whether a generated `--infer` plan is
 * fully executable (every entry has a non-unknown source, valid url
 * for capture, real ref for existing, non-empty destinations, no
 * literal OWNER/REPO placeholders).
 *
 * Non-executable plans result in `needs_edit: true` from the
 * `provision --infer` command — the file is written but no batch is
 * minted. See spec §1 "Executability gate".
 *
 * Note: this function emits at most one issue per entry (the loop
 * uses `continue` after each push). The first failing check for an
 * entry wins; the user fixes that, re-runs, and surfaces the next
 * one. This keeps the issue list focused — re-runs are cheap.
 */

import { validateCaptureUrl } from "../bootstrap/yml.js";

export interface InferredPlanEntry {
  secret: string;
  ref: string;
  source:
    | { kind: "capture"; url?: string }
    | { kind: "human_paste"; url?: string }
    | { kind: "random_32_bytes" }
    | { kind: "random_64_bytes" }
    | { kind: "existing"; placeholder: boolean; ref?: string }
    | { kind: "unknown" };
  destinations: string[];
}

export interface InferGateIssue {
  secret: string;
  issue: string;
}

export interface InferGateResult {
  ok: boolean;
  issues: InferGateIssue[];
}

// Substring match: any destination shorthand containing the literal
// "OWNER/REPO" (e.g., "github-actions:OWNER/REPO" or future variants
// like "gha:OWNER/REPO/env") is treated as an unfilled template.
const PLACEHOLDER_DEST = "OWNER/REPO";

export function isInferYmlExecutable(entries: InferredPlanEntry[]): InferGateResult {
  const issues: InferGateIssue[] = [];

  for (const e of entries) {
    if (e.source.kind === "unknown") {
      issues.push({ secret: e.secret, issue: "source: unknown — pick a kind (capture, human_paste, random_32_bytes, existing)" });
      continue;
    }
    if (e.source.kind === "capture" || e.source.kind === "human_paste") {
      if (typeof e.source.url !== "string" || e.source.url.length === 0) {
        issues.push({ secret: e.secret, issue: `${e.source.kind} source missing required url` });
        continue;
      }
      const urlCheck = validateCaptureUrl(e.source.url);
      if (!urlCheck.ok) {
        issues.push({ secret: e.secret, issue: `${e.source.kind} url invalid: ${urlCheck.reason}` });
        continue;
      }
    }
    if (e.source.kind === "existing") {
      if (e.source.placeholder === true) {
        issues.push({
          secret: e.secret,
          issue: "existing source has placeholder ref — supply a real ss:// ref or change source kind",
        });
        continue;
      }
      if (typeof e.source.ref !== "string" || !e.source.ref.startsWith("ss://")) {
        issues.push({
          secret: e.secret,
          issue: "existing source missing required ref (ss://source/env/NAME)",
        });
        continue;
      }
    }
    if (e.destinations.length === 0) {
      issues.push({ secret: e.secret, issue: "destinations is empty — add at least one" });
      continue;
    }
    if (e.destinations.some((d) => d.includes(PLACEHOLDER_DEST))) {
      issues.push({ secret: e.secret, issue: `destination contains placeholder OWNER/REPO — fill in real owner/repo` });
      continue;
    }
  }

  return { ok: issues.length === 0, issues };
}
