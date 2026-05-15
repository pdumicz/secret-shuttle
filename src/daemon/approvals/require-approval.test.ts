import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { ApprovalStore, type ApprovalBinding } from "./store.js";
import { requireApproval } from "./require-approval.js";

const PROD_BINDING: ApprovalBinding = {
  action: "inject",
  ref: "ss://stripe/prod/STRIPE_WEBHOOK_SECRET",
  environment: "production",
  destination_domain: "vercel.com",
  target_id: "T1",
  field_fingerprint: "sha256:fp",
  template_id: null,
  template_params: null,
};

const DEV_BINDING: ApprovalBinding = {
  ...PROD_BINDING,
  environment: "development",
};

test("dev environments skip approval entirely", async () => {
  const store = new ApprovalStore();
  const grant = await requireApproval({
    store,
    binding: DEV_BINDING,
    daemonPort: 1234,
    openUrlImpl: () => { throw new Error("must not open"); },
  });
  assert.equal(grant.status, "used");
  assert.equal(grant.id, "no-approval-required");
});

test("waitMs=0 throws approval_required without polling", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  let opened = "";
  await assert.rejects(
    () => requireApproval({
      store,
      binding: PROD_BINDING,
      daemonPort: 1234,
      waitMs: 0,
      openUrlImpl: (u) => { opened = u; },
    }),
    (err) => err instanceof ShuttleError && err.code === "approval_required",
  );
  assert.ok(opened.startsWith("http://127.0.0.1:1234/ui/approve?id="));
});

test("approvalIdFromClient consumes an existing grant when bindings match", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const grant = store.create(PROD_BINDING);
  store.approve(grant.id);
  const consumed = await requireApproval({
    store,
    binding: PROD_BINDING,
    daemonPort: 1234,
    approvalIdFromClient: grant.id,
    openUrlImpl: () => { throw new Error("must not open"); },
  });
  assert.equal(consumed.id, grant.id);
  assert.equal(consumed.status, "used");
});

test("approvalIdFromClient rejects mismatched binding", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const grant = store.create(PROD_BINDING);
  store.approve(grant.id);
  await assert.rejects(
    () => requireApproval({
      store,
      binding: { ...PROD_BINDING, destination_domain: "evil.com" },
      daemonPort: 1234,
      approvalIdFromClient: grant.id,
      openUrlImpl: () => {},
    }),
    (err) => err instanceof ShuttleError && err.code === "approval_mismatch",
  );
});

test("polling resolves when approval is granted asynchronously", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const promise = (async () => {
    return await requireApproval({
      store,
      binding: PROD_BINDING,
      daemonPort: 1234,
      waitMs: 5000,
      openUrlImpl: () => {},
    });
  })();

  // grant after a small delay
  await new Promise((r) => setTimeout(r, 50));
  const grants = [...(store as unknown as { grants: Map<string, { id: string }> }).grants.values()];
  assert.equal(grants.length, 1);
  const onlyGrant = grants[0];
  if (onlyGrant === undefined) throw new Error("no grant");
  store.approve(onlyGrant.id);

  const result = await promise;
  assert.equal(result.status, "used");
});

test("polling throws approval_denied if denied", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  const promise = requireApproval({
    store,
    binding: PROD_BINDING,
    daemonPort: 1234,
    waitMs: 5000,
    openUrlImpl: () => {},
  });

  await new Promise((r) => setTimeout(r, 50));
  const grants = [...(store as unknown as { grants: Map<string, { id: string }> }).grants.values()];
  const onlyGrant = grants[0];
  if (onlyGrant === undefined) throw new Error("no grant");
  store.deny(onlyGrant.id);

  await assert.rejects(promise, (err) => err instanceof ShuttleError && err.code === "approval_denied");
});

test("polling times out when no decision is made", async () => {
  const store = new ApprovalStore({ ttlMs: 60_000 });
  await assert.rejects(
    () => requireApproval({
      store,
      binding: PROD_BINDING,
      daemonPort: 1234,
      waitMs: 300,
      openUrlImpl: () => {},
    }),
    (err) => err instanceof ShuttleError && err.code === "approval_timeout",
  );
});
