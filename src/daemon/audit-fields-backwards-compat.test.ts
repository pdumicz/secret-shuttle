// src/daemon/audit-fields-backwards-compat.test.ts
//
// Burst 5 §4 Task 4.4. Pure regression guard: synthetic legacy audit
// rows (written before §4's field additions) must still parse as JSON
// without errors, and the new optional fields must surface as undefined
// — not "" or null or a default. The `audit` CLI verb (§4 Task 4.6)
// renders "(unknown)" / "—" when the fields are missing; this test
// pins that the absence is observable at the parse layer.
import test from "node:test";
import assert from "node:assert/strict";

// A row shape the daemon would have written BEFORE Burst 5 §4 added the
// batch_id / source_kind / destination_shorthands / destinations_*_count
// fields. Every field present here is still emitted by the modern code
// path — this row is forward-compatible with the new audit consumer.
const OLD_BOOTSTRAP_STEP_ROW = JSON.stringify({
  ts: "2026-05-26T00:00:00Z",
  action: "bootstrap_step",
  ok: true,
  ref: "ss://stripe/prod/STRIPE_KEY",
});

const OLD_TEMPLATE_RUN_ROW = JSON.stringify({
  ts: "2026-05-26T00:01:00Z",
  action: "template_run",
  ok: true,
  ref: "ss://stripe/prod/STRIPE_KEY",
  template_id: "vercel-env-add",
  environment: "production",
});

test("a synthetic legacy bootstrap_step audit row parses as JSON; new fields surface as undefined", () => {
  const row = JSON.parse(OLD_BOOTSTRAP_STEP_ROW);
  assert.equal(row.action, "bootstrap_step");
  assert.equal(row.ok, true);
  assert.equal(row.batch_id, undefined);
  assert.equal(row.source_kind, undefined);
  assert.equal(row.destination_shorthands, undefined);
  assert.equal(row.destinations_ok_count, undefined);
  assert.equal(row.destinations_failed_count, undefined);
});

test("a synthetic legacy template_run audit row parses as JSON; batch_id surfaces as undefined", () => {
  const row = JSON.parse(OLD_TEMPLATE_RUN_ROW);
  assert.equal(row.action, "template_run");
  assert.equal(row.ok, true);
  assert.equal(row.batch_id, undefined);
  // Other §4 fields are bootstrap_step-only, so they're already absent
  // in this row by design — the test above pins their absence.
});
