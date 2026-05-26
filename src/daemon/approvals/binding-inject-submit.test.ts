import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalStore, type ApprovalBinding } from "./store.js";

function base(): ApprovalBinding {
  return {
    action: "inject_submit",
    ref: "ss://stripe/prod/WH",
    environment: "production",
    destination_domain: "vercel.com",
    target_id: "T-1",
    field_fingerprint: "sha256:field",
    template_id: null,
    template_params: null,
    submit_fingerprint: "sha256:submit",
    success_condition: "Environment Variable Added",
    auto_resume: true,
    field_handle_label: "value-field",
    submit_handle_label: "submit-button",
  };
}

test("a matching inject_submit binding round-trips through create→consume", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, base(), "daemon");
  assert.equal(used.status, "used");
});

test("a different submit_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), submit_fingerprint: "sha256:OTHER" }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("a different success_condition is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), success_condition: "Something Else" }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("display-only handle labels are NOT part of matching", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, { ...base(), field_handle_label: "renamed", submit_handle_label: "renamed2" }, "daemon");
  assert.equal(used.status, "used");
});

test("allowed_actions is part of matching (approved scope cannot be swapped); order-insensitive", () => {
  const store = new ApprovalStore();
  const gen: ApprovalBinding = {
    action: "generate", ref: null, planned_ref: "ss://local/dev/K", environment: "development",
    destination_domain: null, target_id: null, field_fingerprint: null,
    template_id: null, template_params: null, allowed_domains: [],
    allowed_actions: ["inject_into_field", "inject_submit"],
  };
  const g = store.create(gen);
  store.approve(g.id);
  // reordered same set still matches (stable-set comparison)
  const used = store.consume(g.id, { ...gen, allowed_actions: ["inject_submit", "inject_into_field"] }, "daemon");
  assert.equal(used.status, "used");

  const g2 = store.create(gen);
  store.approve(g2.id);
  assert.throws(
    () => store.consume(g2.id, { ...gen, allowed_actions: ["inject_into_field"] }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("auto_resume:false does not match an approval that omits auto_resume (scope is not nullable-equivalent)", () => {
  const store = new ApprovalStore();
  const g = store.create({ ...base(), auto_resume: false });
  store.approve(g.id);
  const { auto_resume: _omit, ...noFlag } = base();
  assert.throws(
    () => store.consume(g.id, noFlag, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});
