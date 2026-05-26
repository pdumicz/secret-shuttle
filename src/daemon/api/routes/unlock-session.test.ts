import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerUnlockSession } from "./unlock-session.js";
import type { KeychainAdapter } from "../../../vault/keychain/types.js";

// ── shared mock keychain ────────────────────────────────────────────────────

class MockKeychain implements KeychainAdapter {
  available = true;
  readonly entries = new Map<string, Buffer>();

  async isAvailable(): Promise<boolean> { return this.available; }
  async set(service: string, account: string, value: Buffer): Promise<void> {
    this.entries.set(`${service}:${account}`, Buffer.from(value));
  }
  async get(service: string, account: string): Promise<Buffer | null> {
    return this.entries.get(`${service}:${account}`) ?? null;
  }
  async delete(service: string, account: string): Promise<void> {
    this.entries.delete(`${service}:${account}`);
  }
}

// ── shared test harness ─────────────────────────────────────────────────────

interface HarnessOpts {
  keychain?: KeychainAdapter;
  openUrlSpy?: (url: string) => void;
}

async function withUnlockUiDaemon<T>(
  fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>,
  opts: HarnessOpts = {},
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-unlock-ui-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices({
    hubOpenUrlImpl: opts.openUrlSpy ?? (() => { /* no-op */ }),
  });
  if (opts.keychain !== undefined) {
    services.keychain = opts.keychain;
  }
  let port = 0;
  registerUnlockSession(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

// Helper: write an encrypted envelope + set up the vault on disk so
// subsequent keychain-based unlock calls have a real vault to decrypt.
async function bootstrapVaultWithPassphrase(
  port: number,
  services: DaemonServices,
): Promise<{ masterKey: Buffer; envelopeId: string }> {
  // Create the session first so the UI submit path can find it.
  const startRes = await fetch(`http://127.0.0.1:${port}/v1/unlock/start`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: "{}",
  });
  const startBody = await startRes.json() as { session_id: string; requires_create: boolean };
  const { session_id } = startBody;
  const session = services.unlockSessions.get(session_id);
  assert.ok(session, "session must exist");

  // POST the passphrase to the UI submit route.
  const submitUrl = `http://127.0.0.1:${port}/ui/unlock/${session_id}?token=${session.ui_token}`;
  const pass = "test-passphrase-bootstrap";
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: pass, set_passphrase: true }),
  });
  assert.equal(submitRes.status, 200, "passphrase submit must succeed");

  // Re-read the envelope to get its id and the actual master key from the lock state.
  const { readEnvelope: readEnv } = await import("../../../vault/envelope.js");
  const env = await readEnv();
  assert.ok(env !== null, "envelope must exist after bootstrap");

  // The lock holds the master key — extract it (requireKey returns a copy).
  const masterKey = services.lock.requireKey();
  // Re-lock so tests can verify unlock from keychain.
  services.lock.lock();

  return { masterKey, envelopeId: env.id };
}

test("GET /ui/unlock sets CSP with frame-ancestors 'self' + hardening headers", async () => {
  await withUnlockUiDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/unlock`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});

// ── keychain fast-path tests ────────────────────────────────────────────────

test("unlock-session: warm keychain → skips passphrase UI", async () => {
  const keychain = new MockKeychain();

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap: create vault + envelope via passphrase, capture master key.
    const { masterKey, envelopeId } = await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

    // Pre-load the real master key into the mock keychain.
    await keychain.set("secret-shuttle", envelopeId, masterKey);

    // Now POST /v1/unlock/start — should hit the keychain fast path.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;

    // Response shape: keychain path, NOT passphrase UI shape.
    assert.equal(body.unlocked, true, "unlocked must be true");
    assert.equal(body.source, "keychain", "source must be keychain");
    assert.equal("session_id" in body, false, "session_id must NOT be present");

    // Vault is unlocked.
    assert.equal(ctx.services.lock.isUnlocked(), true, "lock must be open");
  }, { keychain });
});

test("unlock-session: no keychain entry → falls through to passphrase UI", async () => {
  const keychain = new MockKeychain(); // empty

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap to create an envelope on disk (so it's not a create=1 flow).
    // C2 enrollment now writes a keychain entry during bootstrap; clear it so
    // the subsequent /v1/unlock/start sees an empty keychain.
    await bootstrapVaultWithPassphrase(ctx.port, ctx.services);
    keychain.entries.clear();

    // POST /v1/unlock/start with empty keychain.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;

    // Response shape: passphrase UI flow — a session was created.
    assert.equal(typeof body.session_id, "string", "session_id must be present");
    assert.equal(body.unlocked, undefined, "unlocked must NOT be present");

    // The session must exist in the store (proves passphrase path was taken).
    assert.ok(
      ctx.services.unlockSessions.get(body.session_id as string) !== undefined,
      "unlock session must exist in store",
    );
  }, { keychain });
});

test("unlock-session: keychain returns invalid key → falls through to passphrase UI", async () => {
  const keychain = new MockKeychain();

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap to create a real vault on disk (so ensureInitialized will try
    // to decrypt it rather than creating a fresh one).
    const { envelopeId } = await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

    // Store a WRONG 32-byte key under the correct account.
    const wrongKey = randomBytes(32);
    await keychain.set("secret-shuttle", envelopeId, wrongKey);

    // POST /v1/unlock/start.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;

    // Should fall through to passphrase UI shape.
    assert.equal(typeof body.session_id, "string", "session_id must be present after fallthrough");

    // Vault must be RE-LOCKED (cleanup after bad key).
    assert.equal(ctx.services.lock.isUnlocked(), false, "lock must be closed after invalid cached key");

    // The session must exist in the store (proves passphrase path was taken).
    assert.ok(
      ctx.services.unlockSessions.get(body.session_id as string) !== undefined,
      "unlock session must exist in store",
    );
  }, { keychain });
});

test("unlock-session: keychain fast-path rethrows unexpected errors instead of silently falling through", async () => {
  const keychain = new MockKeychain();

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap: create vault + envelope via passphrase, capture master key.
    const { masterKey, envelopeId } = await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

    // Pre-load the real master key so the fast-path is entered.
    await keychain.set("secret-shuttle", envelopeId, masterKey);

    // Stub ensureInitialized to throw a non-validation error (simulated I/O failure).
    const originalEnsure = ctx.services.vault.ensureInitialized.bind(ctx.services.vault);
    ctx.services.vault.ensureInitialized = async () => {
      throw new Error("simulated I/O failure");
    };

    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: "{}",
      });

      // Must NOT silently fall through to a passphrase UI response.
      assert.notEqual(res.status, 200, "unexpected error must not return 200");

      // The body must NOT look like a successful passphrase-UI start.
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.unlocked, undefined, "unlocked must NOT be present");
      assert.equal(body.session_id, undefined, "session_id must NOT be present (not silently routed to passphrase UI)");
    } finally {
      // Restore — always, even if assertions throw.
      ctx.services.vault.ensureInitialized = originalEnsure;
    }

    // services.lock must be re-locked (no stray unlocked state after unexpected failure).
    assert.equal(ctx.services.lock.isUnlocked(), false, "lock must be closed after unexpected error");
  }, { keychain });
});

test("unlock-session: keychain unavailable → falls through to passphrase UI", async () => {
  const keychain = new MockKeychain();
  keychain.available = false;

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap to create an envelope on disk.
    await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;

    // Falls through to passphrase UI shape.
    assert.equal(typeof body.session_id, "string", "session_id must be present");
    assert.equal(body.unlocked, undefined, "unlocked must NOT be present");

    // The session must exist in the store (proves passphrase path was taken).
    assert.ok(
      ctx.services.unlockSessions.get(body.session_id as string) !== undefined,
      "unlock session must exist in store",
    );
  }, { keychain });
});

// ── C2: opportunistic keychain enrollment after passphrase unlock ────────────

test("unlock-session: successful passphrase unlock writes master key to keychain", async () => {
  const keychain = new MockKeychain(); // empty — no cached entry

  await withUnlockUiDaemon(async (ctx) => {
    // Start a session (no envelope exists yet → create=1 flow).
    const startRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json() as { session_id: string };
    const { session_id } = startBody;
    const session = ctx.services.unlockSessions.get(session_id);
    assert.ok(session, "session must exist");

    // Submit the passphrase via the UI route (set_passphrase=true → creates vault).
    const submitUrl = `http://127.0.0.1:${ctx.port}/ui/unlock/${session_id}?token=${session.ui_token}`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct-passphrase", set_passphrase: true }),
    });
    assert.equal(submitRes.status, 200, "passphrase submit must succeed");

    // Vault must be unlocked.
    assert.equal(ctx.services.lock.isUnlocked(), true, "lock must be open after passphrase unlock");

    // Read the envelope to find its id.
    const { readEnvelope: readEnv } = await import("../../../vault/envelope.js");
    const env = await readEnv();
    assert.ok(env !== null, "envelope must exist");

    // Keychain must now hold an entry for this envelope.
    const cached = await keychain.get("secret-shuttle", env.id);
    assert.ok(cached !== null, "keychain must have been populated");

    // The cached value must match the actual master key.
    const masterKey = ctx.services.lock.requireKey();
    assert.deepEqual(cached, masterKey, "cached key must match the master key");
  }, { keychain });
});

test("unlock-session: keychain.set failure does NOT block unlock", async () => {
  // Wrap MockKeychain so set() always throws.
  const base = new MockKeychain();
  let setCalled = 0;
  const throwingKeychain: KeychainAdapter = {
    async isAvailable() { return base.isAvailable(); },
    async set(_svc, _acct, _val) {
      setCalled++;
      throw new Error("simulated keychain.set failure");
    },
    async get(svc, acct) { return base.get(svc, acct); },
    async delete(svc, acct) { return base.delete(svc, acct); },
  };

  await withUnlockUiDaemon(async (ctx) => {
    const startRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json() as { session_id: string };
    const { session_id } = startBody;
    const session = ctx.services.unlockSessions.get(session_id);
    assert.ok(session, "session must exist");

    const submitUrl = `http://127.0.0.1:${ctx.port}/ui/unlock/${session_id}?token=${session.ui_token}`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct-passphrase", set_passphrase: true }),
    });

    // Unlock must succeed even though keychain.set threw.
    assert.equal(submitRes.status, 200, "unlock must succeed despite keychain.set failure");
    const body = await submitRes.json() as Record<string, unknown>;
    assert.equal(body.ok, true, "response ok must be true");

    // Vault must be unlocked.
    assert.equal(ctx.services.lock.isUnlocked(), true, "lock must be open despite keychain.set failure");

    // set was attempted (confirming the enrollment code ran).
    assert.ok(setCalled > 0, "keychain.set must have been called");
  }, { keychain: throwingKeychain });
});

test("unlock-session: keychain unavailable → no enrollment, no error", async () => {
  const keychain = new MockKeychain();
  keychain.available = false;
  let setCalled = 0;
  const original = keychain.set.bind(keychain);
  keychain.set = async (svc, acct, val) => {
    setCalled++;
    return original(svc, acct, val);
  };

  await withUnlockUiDaemon(async (ctx) => {
    const startRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json() as { session_id: string };
    const { session_id } = startBody;
    const session = ctx.services.unlockSessions.get(session_id);
    assert.ok(session, "session must exist");

    const submitUrl = `http://127.0.0.1:${ctx.port}/ui/unlock/${session_id}?token=${session.ui_token}`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "correct-passphrase", set_passphrase: true }),
    });
    assert.equal(submitRes.status, 200, "unlock must succeed when keychain is unavailable");

    // Vault is unlocked.
    assert.equal(ctx.services.lock.isUnlocked(), true, "lock must be open");

    // keychain.set must NOT have been called (enrollment skipped when unavailable).
    assert.equal(setCalled, 0, "keychain.set must NOT be called when keychain is unavailable");
  }, { keychain });
});

// ── P2.1: marker backfill on keychain fast-path ─────────────────────────────

test("keychain fast-path: backfills marker for pre-marker enrollments", async () => {
  // Simulates a user who enrolled before commit 05e8e7e (marker pattern).
  // They have the real master key entry in the keychain but NO marker entry.
  // After a successful fast-path unlock, the marker must be written so that
  // subsequent /v1/keychain/status calls report enrolled: true.
  const keychain = new MockKeychain();

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap: create vault + envelope via passphrase, capture master key.
    const { masterKey, envelopeId } = await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

    // Pre-load the real master key. The marker was written by C2 during bootstrap,
    // so delete it to simulate the pre-05e8e7e enrollment state (real key present,
    // no marker).
    await keychain.set("secret-shuttle", envelopeId, masterKey);
    await keychain.entries.delete(`secret-shuttle:${envelopeId}:enrolled`);
    assert.equal(
      await keychain.get("secret-shuttle", `${envelopeId}:enrolled`),
      null,
      "marker must be absent before fast-path unlock (simulates pre-05e8e7e state)",
    );

    // Re-lock first.
    ctx.services.lock.lock();

    // POST /v1/unlock/start — should hit the keychain fast path.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.unlocked, true, "unlocked must be true (fast-path succeeded)");
    assert.equal(body.source, "keychain", "source must be keychain");

    // After unlock, the marker MUST have been backfilled.
    const marker = await keychain.get("secret-shuttle", `${envelopeId}:enrolled`);
    assert.ok(marker !== null, "marker must be present after fast-path unlock (backfilled)");
    assert.equal(marker.toString(), "enrolled", "marker value must be 'enrolled'");
  }, { keychain });
});

// ── P1.1 opt-out regression tests ──────────────────────────────────────────

test("unlock-session: opt-out vault skips keychain (no read, no enroll)", async () => {
  const keychain = new MockKeychain();
  let getCalled = 0;
  let setCalled = 0;
  const counting: KeychainAdapter = {
    async isAvailable() { return keychain.isAvailable(); },
    async set(s, a, v) { setCalled++; return keychain.set(s, a, v); },
    async get(s, a) { getCalled++; return keychain.get(s, a); },
    async delete(s, a) { return keychain.delete(s, a); },
  };

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap: create vault via passphrase (which may call set via C2).
    const { envelopeId } = await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

    // Set opt-out flag on the envelope directly.
    const env = await (await import("../../../vault/envelope.js")).readEnvelope();
    assert.ok(env !== null);
    await (await import("../../../vault/envelope.js")).writeEnvelope({ ...env, keychain_opt_out: true });
    // Also clear any keychain entry that C2 may have written during bootstrap.
    keychain.entries.clear();
    getCalled = 0;
    setCalled = 0;

    // Now POST /v1/unlock/start — should skip keychain read entirely.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;

    // Must fall through to passphrase UI (no keychain fast-path).
    assert.equal(typeof body.session_id, "string", "session_id must be present (skipped keychain)");
    assert.equal(getCalled, 0, "keychain.get must NOT be called when opt-out is set");

    // Submit passphrase to unlock.
    const session = ctx.services.unlockSessions.get(body.session_id as string);
    assert.ok(session, "session must exist");
    const submitUrl = `http://127.0.0.1:${ctx.port}/ui/unlock/${body.session_id}?token=${session.ui_token}`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "test-passphrase-bootstrap", set_passphrase: false }),
    });
    assert.equal(submitRes.status, 200, "passphrase unlock must succeed");

    // C2 enroll must NOT have been called.
    assert.equal(setCalled, 0, "keychain.set must NOT be called when opt-out is set (C2 suppressed)");
    // Keychain must still be empty.
    const entry = keychain.entries.get(`secret-shuttle:${envelopeId}`);
    assert.equal(entry, undefined, "keychain must remain empty when opt-out is set");
  }, { keychain: counting });
});

test("unlock-session: clearing opt-out (enable) resumes keychain caching", async () => {
  const keychain = new MockKeychain();
  let setCalled = 0;
  const counting: KeychainAdapter = {
    async isAvailable() { return keychain.isAvailable(); },
    async set(s, a, v) { setCalled++; return keychain.set(s, a, v); },
    async get(s, a) { return keychain.get(s, a); },
    async delete(s, a) { return keychain.delete(s, a); },
  };

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap with opt-out flag set.
    await bootstrapVaultWithPassphrase(ctx.port, ctx.services);
    const env = await (await import("../../../vault/envelope.js")).readEnvelope();
    assert.ok(env !== null);
    await (await import("../../../vault/envelope.js")).writeEnvelope({ ...env, keychain_opt_out: true });
    keychain.entries.clear();
    setCalled = 0;

    // Confirm that with opt-out, set is not called on next passphrase unlock.
    ctx.services.lock.lock();
    const startRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json() as { session_id: string };
    const session = ctx.services.unlockSessions.get(startBody.session_id);
    assert.ok(session, "session must exist");
    const submitUrl = `http://127.0.0.1:${ctx.port}/ui/unlock/${startBody.session_id}?token=${session.ui_token}`;
    await fetch(submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "test-passphrase-bootstrap", set_passphrase: false }),
    });
    assert.equal(setCalled, 0, "keychain.set must NOT be called when opt-out is still set");

    // Now clear the opt-out by writing the envelope without the flag.
    const envAfter = await (await import("../../../vault/envelope.js")).readEnvelope();
    assert.ok(envAfter !== null);
    await (await import("../../../vault/envelope.js")).writeEnvelope({ ...envAfter, keychain_opt_out: false });
    setCalled = 0;

    // Re-lock and unlock via passphrase — C2 should now enroll.
    ctx.services.lock.lock();
    const startRes2 = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{}",
    });
    const startBody2 = await startRes2.json() as { session_id: string };
    const session2 = ctx.services.unlockSessions.get(startBody2.session_id);
    assert.ok(session2, "session must exist after opt-out cleared");
    const submitUrl2 = `http://127.0.0.1:${ctx.port}/ui/unlock/${startBody2.session_id}?token=${session2.ui_token}`;
    await fetch(submitUrl2, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "test-passphrase-bootstrap", set_passphrase: false }),
    });
    assert.ok(setCalled > 0, "keychain.set must be called after opt-out is cleared (C2 resumed)");
  }, { keychain: counting });
});

// ── P1 post-ship: skip_keychain per-request flag ────────────────────────────

test("unlock-session: skip_keychain=true → C1 keychain fast-path is skipped (no get)", async () => {
  const keychain = new MockKeychain();
  let getCalled = 0;
  const counting: KeychainAdapter = {
    async isAvailable() { return keychain.isAvailable(); },
    async set(s, a, v) { return keychain.set(s, a, v); },
    async get(s, a) { getCalled++; return keychain.get(s, a); },
    async delete(s, a) { return keychain.delete(s, a); },
  };

  await withUnlockUiDaemon(async (ctx) => {
    // Bootstrap vault; C2 populates the keychain entry.
    const { masterKey, envelopeId } = await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

    // Verify: keychain has the real key (C2 ran during bootstrap).
    const cached = await keychain.get("secret-shuttle", envelopeId);
    assert.ok(cached !== null, "keychain must have entry after bootstrap");
    assert.deepEqual(cached, masterKey, "cached key must match master key");
    getCalled = 0; // reset counter after bootstrap reads

    // Re-lock so we're in a locked state for the next request.
    ctx.services.lock.lock();

    // POST /v1/unlock/start with skip_keychain: true — must NOT read from keychain (C1 skipped).
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ skip_keychain: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;

    // Must fall through to passphrase UI — NOT the keychain fast-path.
    assert.equal(typeof body.session_id, "string", "session_id must be present (C1 skipped)");
    assert.equal(body.unlocked, undefined, "unlocked must NOT be present (C1 skipped)");

    // keychain.get must not have been called (C1 skipped).
    assert.equal(getCalled, 0, "keychain.get must NOT be called when skip_keychain=true");
  }, { keychain: counting });
});

test("unlock-session: skip_keychain=true on create-vault flow → envelope has keychain_opt_out=true, C2 never called", async () => {
  const keychain = new MockKeychain();
  let setCalled = 0;
  const counting: KeychainAdapter = {
    async isAvailable() { return keychain.isAvailable(); },
    async set(s, a, v) { setCalled++; return keychain.set(s, a, v); },
    async get(s, a) { return keychain.get(s, a); },
    async delete(s, a) { return keychain.delete(s, a); },
  };

  await withUnlockUiDaemon(async (ctx) => {
    // No envelope exists yet — this is a fresh create=1 flow.
    const startRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock/start`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ skip_keychain: true }),
    });
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json() as { session_id: string; requires_create: boolean };
    assert.equal(startBody.requires_create, true, "must be a create flow (no envelope)");
    const { session_id } = startBody;
    const session = ctx.services.unlockSessions.get(session_id);
    assert.ok(session, "session must exist");
    assert.equal(session.skip_keychain, true, "session must carry skip_keychain flag");

    // Submit the passphrase to create the vault.
    const submitUrl = `http://127.0.0.1:${ctx.port}/ui/unlock/${session_id}?token=${session.ui_token}`;
    const submitRes = await fetch(submitUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "my-passphrase", set_passphrase: true }),
    });
    assert.equal(submitRes.status, 200, "passphrase submit must succeed");

    // Read the envelope — must have keychain_opt_out: true.
    const { readEnvelope: readEnv } = await import("../../../vault/envelope.js");
    const env = await readEnv();
    assert.ok(env !== null, "envelope must exist after create flow");
    assert.equal(env.keychain_opt_out, true, "envelope must have keychain_opt_out=true when skip_keychain was set");

    // C2 must NOT have been called.
    assert.equal(setCalled, 0, "keychain.set must NEVER be called when skip_keychain=true (C2 suppressed)");
  }, { keychain: counting });
});
