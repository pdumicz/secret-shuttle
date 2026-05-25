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
    await bootstrapVaultWithPassphrase(ctx.port, ctx.services);

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
