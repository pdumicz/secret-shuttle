import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { ApprovalStore, type ApprovalBinding } from "./store.js";
import { requireApproval } from "./require-approval.js";
import { SessionStore } from "./session-store.js";

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

test("requireApproval: matching session → returns session-minted grant; no openUrl call", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let opens = 0;
  const grant = await requireApproval({
    store,
    sessionStore: sessions,
    sessionId: sg.id,
    binding: {
      action: "template",
      ref: "ss://x/prod/A",
      environment: "production",
      destination_domain: null, // current template-run binding shape (templates.ts:91)
      target_id: null,
      field_fingerprint: null,
      template_id: "vercel-env-add",
      template_params: null,
      allowed_domains: [],
    },
    daemonPort: 0,
    openUrlImpl: () => { opens += 1; },
  });
  assert.equal(grant.session_id, sg.id);
  assert.equal(grant.status, "used");
  assert.equal(opens, 0);
});

test("requireApproval: session_pattern_no_match falls back to single-use flow", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://OTHER/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: sg.id,
      binding: {
        action: "template",
        ref: "ss://x/prod/A", // outside pattern.ref_glob
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: "vercel-env-add",
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      waitMs: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "approval_required",
  );
  assert.equal(opens, 1, "single-use fallback should have opened a tab");
});

test("requireApproval: session_not_found re-thrown (no fallback)", async () => {
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: "does-not-exist",
      binding: {
        action: "template",
        ref: "ss://x/prod/A",
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: "vercel-env-add",
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
  assert.equal(opens, 0);
});

test("requireApproval: session_expired re-thrown (no fallback)", async () => {
  let nowVal = 1_000_000;
  const sessions = new SessionStore({ now: () => nowVal });
  const sg = sessions.create({
    actions: ["template-run"],
    ref_glob: "ss://x/prod/*",
    destination_domains: [],
    template_ids: ["vercel-env-add"],
    ttl_ms: 1000,
  });
  sessions.approve(sg.id);
  nowVal += 2000;
  const store = new ApprovalStore();
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: sg.id,
      binding: {
        action: "template",
        ref: "ss://x/prod/A",
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: "vercel-env-add",
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      waitMs: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
  assert.equal(opens, 0);
});

test("requireApproval: secrets_delete binding with a session → pattern_no_match → falls back to single-use", async () => {
  // The session can't include secrets-delete (it's not a SessionAction).
  // Passing session_id with a secrets_delete binding canonicalizes to null,
  // matcher returns false → pattern_no_match → falls through to single-use.
  const store = new ApprovalStore();
  const sessions = new SessionStore();
  // Broadest legal pattern: all 4 SessionActions + non-empty destination_domains
  // + template_ids + allowed_actions covering the full ALL_SECRET_ACTIONS set.
  const sg = sessions.create({
    actions: ["template-run", "inject-submit", "reveal-capture", "secrets-set"],
    ref_glob: "",
    destination_domains: ["any.com"],
    template_ids: ["any"],
    allowed_actions: [
      "capture_from_page",
      "inject_into_field",
      "compare_fingerprint",
      "use_as_stdin",
      "inject_submit",
    ],
    ttl_ms: 60_000,
  });
  sessions.approve(sg.id);
  let opens = 0;
  await assert.rejects(
    requireApproval({
      store,
      sessionStore: sessions,
      sessionId: sg.id,
      binding: {
        action: "secrets_delete",
        ref: "ss://x/prod/A",
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: [],
      },
      daemonPort: 0,
      waitMs: 0,
      openUrlImpl: () => { opens += 1; },
    }),
    (err: Error & { code?: string }) => err.code === "approval_required",
  );
  assert.equal(opens, 1);
});
