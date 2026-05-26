import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalStore, type ApprovalBinding } from "./store.js";

function base(): ApprovalBinding {
  return {
    action: "reveal_capture",
    ref: null,
    planned_ref: "ss://stripe/prod/WH",
    environment: "production",
    destination_domain: "dashboard.stripe.com",
    target_id: "T-1",
    field_fingerprint: null,
    template_id: null,
    template_params: null,
    allowed_domains: ["dashboard.stripe.com"],
    reveal_fingerprint: "sha256:reveal",
    hide_fingerprint: "sha256:hide",
    container_fingerprint: "sha256:container",
    capture_mode: "container",
    auto_resume: true,
    reveal_handle_label: "reveal-button",
    hide_handle_label: "hide-button",
    container_handle_label: "secret-card",
  };
}

test("a matching reveal_capture binding round-trips through create→approve→consume", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, base(), "daemon");
  assert.equal(used.status, "used");
});

test("a different reveal_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), reveal_fingerprint: "sha256:OTHER" }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("a different container_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), container_fingerprint: "sha256:OTHER" }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("a different capture_mode is an approval_mismatch (mode is part of the approved plan)", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), capture_mode: "focused-after-reveal" }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("absent vs explicit-null capture_mode both normalize to the same match", () => {
  const store = new ApprovalStore();
  const { capture_mode: _cm, ...noMode } = base();
  const g = store.create(noMode);
  store.approve(g.id);
  const used = store.consume(g.id, { ...noMode, capture_mode: null }, "daemon");
  assert.equal(used.status, "used");
});

test("a different hide_fingerprint is an approval_mismatch", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  assert.throws(
    () => store.consume(g.id, { ...base(), hide_fingerprint: "sha256:OTHER" }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});

test("absent vs explicit-null hide_fingerprint both normalize to the same match (no-hide-handle case)", () => {
  const store = new ApprovalStore();
  const { hide_fingerprint: _h, hide_handle_label: _hl, ...noHide } = base();
  const g = store.create(noHide);
  store.approve(g.id);
  const used = store.consume(g.id, { ...noHide, hide_fingerprint: null }, "daemon");
  assert.equal(used.status, "used");
});

test("display-only reveal/hide/container handle labels are NOT part of matching", () => {
  const store = new ApprovalStore();
  const g = store.create(base());
  store.approve(g.id);
  const used = store.consume(g.id, {
    ...base(),
    reveal_handle_label: "renamed-r",
    hide_handle_label: "renamed-h",
    container_handle_label: "renamed-c",
  }, "daemon");
  assert.equal(used.status, "used");
});

test("field-mode binding: field_fingerprint participates, container_fingerprint absent", () => {
  const store = new ApprovalStore();
  const fieldBinding: ApprovalBinding = {
    ...base(),
    capture_mode: "field",
    field_fingerprint: "sha256:thefield",
    container_fingerprint: null,
    container_handle_label: null,
    field_handle_label: "secret-field",
  };
  const g = store.create(fieldBinding);
  store.approve(g.id);
  assert.equal(store.consume(g.id, { ...fieldBinding }, "daemon").status, "used");

  const g2 = store.create(fieldBinding);
  store.approve(g2.id);
  assert.throws(
    () => store.consume(g2.id, { ...fieldBinding, field_fingerprint: "sha256:OTHER" }, "daemon"),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "approval_mismatch",
  );
});
