import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "./session-store.js";
import { type SessionPattern, PENDING_TTL_MS } from "./session.js";

function makePattern(overrides: Partial<SessionPattern> = {}): SessionPattern {
  return {
    actions: ["template-run"],
    ref_glob: "ss://stripe/prod/*",
    destination_domains: ["vercel.com"],
    template_ids: ["vercel-env-add"], // required for template-run patterns
    ttl_ms: 5 * 60 * 1000,
    ...overrides,
  };
}

function makeStore(now: () => number = () => Date.now()): SessionStore {
  return new SessionStore({ now });
}

// create + initial state
test("SessionStore.create: returns a pending grant with PENDING_TTL_MS as expires_at", () => {
  const start = 1_000_000;
  const store = makeStore(() => start);
  const g = store.create(makePattern({ ttl_ms: 10 * 60 * 1000 }));
  assert.equal(g.status, "pending");
  assert.equal(g.created_at, start);
  assert.equal(g.approved_at, null);
  assert.equal(g.expires_at, start + PENDING_TTL_MS); // PENDING window, NOT pattern.ttl_ms
  assert.equal(g.uses, 0);
  assert.equal(typeof g.id, "string");
  assert.equal(typeof g.ui_token, "string");
  assert.notEqual(g.id, g.ui_token);
});

test("SessionStore.create: runs assertSessionPatternValid", () => {
  const store = makeStore();
  assert.throws(
    () => store.create(makePattern({ actions: [] })),
    (err: Error & { code?: string }) => err.code === "bad_request",
  );
});

// pending → expired (existing semantic)
test("SessionStore.get: pending → expired when now > PENDING_TTL_MS past created_at", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern());
  assert.equal(store.get(g.id)!.status, "pending");
  nowVal += PENDING_TTL_MS + 1;
  assert.equal(store.get(g.id)!.status, "expired");
});

// approve() RESETS expires_at to now + pattern.ttl_ms
test("SessionStore.approve: resets expires_at = now + pattern.ttl_ms (TTL anchored at approval)", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const ttl = 10 * 60 * 1000;
  const g = store.create(makePattern({ ttl_ms: ttl }));
  // Human waits 90 seconds (1.5 minutes) before approving.
  nowVal += 90_000;
  store.approve(g.id);
  const after = store.get(g.id)!;
  assert.equal(after.status, "granted");
  assert.equal(after.approved_at, nowVal);
  // expires_at is now PATTERN.ttl_ms from the moment of approval, not creation.
  assert.equal(after.expires_at, nowVal + ttl);
});

// granted → expired (the P0 fix)
test("SessionStore.get: granted → expired when now > expires_at (P0 fix)", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern({ ttl_ms: 60_000 }));
  store.approve(g.id);
  assert.equal(store.get(g.id)!.status, "granted");
  nowVal += 60_001;
  // Without the fix this would still say "granted" forever.
  assert.equal(store.get(g.id)!.status, "expired");
});

// approve() on already-expired pending → session_expired
test("SessionStore.approve: rejects an expired-pending session with session_not_pending", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern());
  nowVal += PENDING_TTL_MS + 1; // pending window elapsed
  assert.throws(
    () => store.approve(g.id),
    (err: Error & { code?: string }) => err.code === "session_not_pending",
  );
});

test("SessionStore.deny: pending → denied", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.deny(g.id);
  assert.equal(store.get(g.id)!.status, "denied");
});

test("SessionStore.revoke: granted → revoked", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  store.revoke(g.id);
  assert.equal(store.get(g.id)!.status, "revoked");
});

test("SessionStore.revoke: unknown id throws session_not_found", () => {
  const store = makeStore();
  assert.throws(
    () => store.revoke("nope"),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("SessionStore.list: insertion order", () => {
  const store = makeStore();
  const a = store.create(makePattern());
  const b = store.create(makePattern());
  const c = store.create(makePattern());
  assert.deepEqual(store.list().map((g) => g.id), [a.id, b.id, c.id]);
});

test("SessionStore.list: normalizes expiry — expired-but-untouched sessions show 'expired' (P2 fix)", () => {
  // Round-2 review caught: list() returned raw map values, so a granted
  // session whose expires_at had passed (but whose status field hadn't been
  // touched via get()) would still appear as 'granted' to /v1/approvals/sessions
  // and the CLI. Now list() runs the same expiry transition as get().
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const granted = store.create(makePattern({ ttl_ms: 1000 }));
  store.approve(granted.id);
  const pendingForever = store.create(makePattern()); // long PENDING window
  nowVal += 5000; // past granted's ttl AND past pendingForever's pending TTL? (PENDING_TTL_MS=120_000) → no
  // Bump well past PENDING_TTL_MS for the pending session.
  nowVal += 200_000;
  const listed = store.list();
  const grantedAfter = listed.find((g) => g.id === granted.id)!;
  const pendingAfter = listed.find((g) => g.id === pendingForever.id)!;
  assert.equal(grantedAfter.status, "expired");
  assert.equal(pendingAfter.status, "expired");
});

// incrementUses
test("SessionStore.incrementUses: granted session counts up", () => {
  const store = makeStore();
  const g = store.create(makePattern({ max_uses: 3 }));
  store.approve(g.id);
  store.incrementUses(g.id);
  store.incrementUses(g.id);
  assert.equal(store.get(g.id)!.uses, 2);
});

test("SessionStore.incrementUses: throws at max_uses cap", () => {
  const store = makeStore();
  const g = store.create(makePattern({ max_uses: 2 }));
  store.approve(g.id);
  store.incrementUses(g.id);
  store.incrementUses(g.id);
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_max_uses_exceeded",
  );
});

test("SessionStore.incrementUses: max_uses undefined → unlimited", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  for (let i = 0; i < 50; i++) store.incrementUses(g.id);
  assert.equal(store.get(g.id)!.uses, 50);
});

test("SessionStore.incrementUses: pending status throws session_not_pending", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_not_pending",
  );
});

test("SessionStore.incrementUses: expired (granted but expires_at past) throws session_expired", () => {
  let nowVal = 1_000_000;
  const store = new SessionStore({ now: () => nowVal });
  const g = store.create(makePattern({ ttl_ms: 1000 }));
  store.approve(g.id);
  nowVal += 2000;
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_expired",
  );
});

test("SessionStore.incrementUses: revoked session throws session_not_found", () => {
  const store = makeStore();
  const g = store.create(makePattern());
  store.approve(g.id);
  store.revoke(g.id);
  assert.throws(
    () => store.incrementUses(g.id),
    (err: Error & { code?: string }) => err.code === "session_not_found",
  );
});

test("SessionStore.get: unknown id returns undefined", () => {
  const store = makeStore();
  assert.equal(store.get("nope"), undefined);
});
