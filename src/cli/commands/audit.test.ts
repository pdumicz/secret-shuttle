// src/cli/commands/audit.test.ts
//
// Burst 5 §4 Task 4.6 — unit tests for the pure helpers exported from
// audit.ts. The route-level behaviour (owner-scoping, BootstrapStore-first
// lookup, audit-log fallback) is covered by audit-summary.test.ts on the
// daemon side.

import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration, renderText } from "./audit.js";
import { ShuttleError } from "../../shared/errors.js";

// ── parseDuration ──────────────────────────────────────────────────────────

test("parseDuration: 5m → 5 * 60_000 ms", () => {
  assert.equal(parseDuration("5m"), 5 * 60_000);
});

test("parseDuration: 1h → 1 * 3_600_000 ms", () => {
  assert.equal(parseDuration("1h"), 3_600_000);
});

test("parseDuration: 7d → 7 * 86_400_000 ms", () => {
  assert.equal(parseDuration("7d"), 7 * 86_400_000);
});

test("parseDuration: 30s → 30 * 1000 ms", () => {
  assert.equal(parseDuration("30s"), 30_000);
});

test("parseDuration: 0d → 0 (zero is a valid duration)", () => {
  // Edge: 0d still parses cleanly. The route treats sinceMs=0 as "anything
  // newer than now", which is a defensible no-op for an agent passing
  // --since 0d to mean "just this moment".
  assert.equal(parseDuration("0d"), 0);
});

test("parseDuration: 'bad' → audit_window_invalid", () => {
  assert.throws(
    () => parseDuration("bad"),
    (e: unknown) => {
      assert.ok(e instanceof ShuttleError, "must be a ShuttleError");
      assert.equal(e.code, "audit_window_invalid");
      return true;
    },
  );
});

test("parseDuration: empty string → audit_window_invalid", () => {
  assert.throws(
    () => parseDuration(""),
    (e: unknown) => e instanceof ShuttleError && e.code === "audit_window_invalid",
  );
});

test("parseDuration: bare number ('5') → audit_window_invalid", () => {
  assert.throws(
    () => parseDuration("5"),
    (e: unknown) => e instanceof ShuttleError && e.code === "audit_window_invalid",
  );
});

test("parseDuration: unsupported unit ('5y') → audit_window_invalid", () => {
  assert.throws(
    () => parseDuration("5y"),
    (e: unknown) => e instanceof ShuttleError && e.code === "audit_window_invalid",
  );
});

// ── renderText ─────────────────────────────────────────────────────────────

test("renderText: empty response → 'no batches' marker", () => {
  const out = renderText({});
  assert.match(out, /Audit summary/);
  assert.match(out, /\(no batches in window\)/);
});

test("renderText: live batch with ok step renders status + destinations", () => {
  const out = renderText({
    since: "5m",
    summary: {
      batches: [
        {
          id: "abc123",
          status: "completed",
          source: "live",
          steps: [
            {
              ok: true,
              ref: "ss://local/dev/FOO",
              source_kind: "random_32_bytes",
              destinations: ["vercel:production"],
            },
          ],
        },
      ],
    },
  });
  assert.match(out, /batch abc123 \[completed\]/);
  assert.match(out, /ok.*ss:\/\/local\/dev\/FOO/);
  assert.match(out, /random_32_bytes -> vercel:production/);
});

test("renderText: audit-reconstructed batch → '(reconstructed from audit log)'", () => {
  const out = renderText({
    summary: {
      batches: [
        {
          id: "lost-batch",
          source: "audit",
          steps: [{ ok: false, error_code: "destination_unreachable" }],
        },
      ],
    },
  });
  assert.match(out, /\(reconstructed from audit log\)/);
  assert.match(out, /ERR/);
  assert.match(out, /error: destination_unreachable/);
});

test("renderText: mixed ok/failed/pending batch renders three distinct status markers", () => {
  // P2-3: pending steps (status="pending") must render as "..." — not "ERR" —
  // so the human can see that the executor hasn't attempted that step yet.
  // Real failures (status="failed") still get "ERR" + the error_code line.
  const out = renderText({
    since: "5m",
    summary: {
      batches: [
        {
          id: "mixed",
          status: "failed_partial",
          source: "live",
          steps: [
            { status: "ok", ok: true, ref: "ss://local/prod/A", source_kind: "random_32_bytes" },
            {
              status: "failed",
              ok: false,
              ref: "ss://local/prod/B",
              source_kind: "random_64_bytes",
              error_code: "template_exec_failed",
            },
            {
              status: "pending",
              ok: false,
              ref: "ss://local/prod/C",
              source_kind: "random_32_bytes",
            },
          ],
        },
      ],
    },
  });
  // Each marker appears exactly where it should.
  assert.match(out, /ok\s+ss:\/\/local\/prod\/A/);
  assert.match(out, /ERR\s+ss:\/\/local\/prod\/B/);
  assert.match(out, /\.\.\.\s+ss:\/\/local\/prod\/C/);
  // Real failure carries error_code line; pending step does NOT.
  assert.match(out, /error: template_exec_failed/);
  // Pending step ref does NOT appear on an "error:" line.
  const pendingErrorLine = new RegExp(
    `error:.*ss:\\/\\/local\\/prod\\/C`,
  );
  assert.doesNotMatch(out, pendingErrorLine);
});

test("renderText: legacy step shape without `status` field still renders (back-compat)", () => {
  // Older daemons emit `ok: boolean` without the new `status` discriminator.
  // The renderer must fall back to the `ok` field so a mixed cluster (newer
  // CLI talking to an older daemon) doesn't crash or mis-render.
  const out = renderText({
    summary: {
      batches: [
        {
          id: "legacy",
          source: "audit",
          steps: [
            { ok: true, ref: "ss://local/dev/legacy-ok" },
            { ok: false, ref: "ss://local/dev/legacy-err", error_code: "destination_unreachable" },
          ],
        },
      ],
    },
  });
  assert.match(out, /ok\s+ss:\/\/local\/dev\/legacy-ok/);
  assert.match(out, /ERR\s+ss:\/\/local\/dev\/legacy-err/);
  assert.match(out, /error: destination_unreachable/);
});

test("renderText: individual_ops section renders user-facing actions", () => {
  const out = renderText({
    summary: {
      batches: [],
      individual_ops: [
        { ts: "2026-05-27T12:00:00Z", action: "unlock", ok: true },
        {
          ts: "2026-05-27T12:01:00Z",
          action: "inject",
          ok: false,
          ref: "ss://local/dev/X",
          error_code: "destination_partial_failure",
        },
      ],
    },
  });
  assert.match(out, /individual operations:/);
  assert.match(out, /ok.*unlock/);
  assert.match(out, /ERR.*inject ss:\/\/local\/dev\/X \(destination_partial_failure\)/);
});
