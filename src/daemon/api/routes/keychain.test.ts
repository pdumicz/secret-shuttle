import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import type { KeychainAdapter } from "../../../vault/keychain/types.js";
import { registerKeychainRoutes } from "./keychain.js";
import { encryptEnvelope, writeEnvelope } from "../../../vault/envelope.js";

// ── shared mock keychain ────────────────────────────────────────────────────

class MockKeychain implements KeychainAdapter {
  available = true;
  readonly entries = new Map<string, Buffer>();

  async isAvailable(): Promise<boolean> { return this.available; }
  async set(service: string, account: string, value: Buffer): Promise<void> {
    if (!this.available) throw new Error("keychain unavailable");
    this.entries.set(`${service}:${account}`, Buffer.from(value));
  }
  async get(service: string, account: string): Promise<Buffer | null> {
    if (!this.available) throw new Error("keychain unavailable");
    return this.entries.get(`${service}:${account}`) ?? null;
  }
  async delete(service: string, account: string): Promise<void> {
    if (!this.available) throw new Error("keychain unavailable");
    this.entries.delete(`${service}:${account}`);
  }
}

// ── shared test harness ─────────────────────────────────────────────────────

async function withKeychainDaemon<T>(
  fn: (ctx: { port: number; services: DaemonServices; home: string }) => Promise<T>,
  keychain?: KeychainAdapter,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-keychain-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  if (keychain !== undefined) {
    services.keychain = keychain;
  }
  let port = 0;
  registerKeychainRoutes(server, services);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services, home });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

function call(
  port: number,
  method: string,
  p: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { authorization: "Bearer t" },
  }).then(async (res) => ({
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  }));
}

// Helper: write a real encrypted envelope and unlock the vault with its master key.
async function bootstrapVault(services: DaemonServices): Promise<{ masterKey: Buffer; envelopeId: string }> {
  const masterKey = randomBytes(32);
  const envelope = await encryptEnvelope(masterKey, "test-passphrase");
  await writeEnvelope(envelope);
  services.lock.unlock(masterKey);
  return { masterKey, envelopeId: envelope.id };
}

// ── POST /v1/keychain/enable ────────────────────────────────────────────────

test("POST /v1/keychain/enable: requires unlocked vault", async () => {
  const keychain = new MockKeychain();
  await withKeychainDaemon(async (ctx) => {
    // Write an envelope but do NOT unlock.
    await bootstrapVault(ctx.services);
    ctx.services.lock.lock();

    const r = await call(ctx.port, "POST", "/v1/keychain/enable");
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "vault_locked");
  }, keychain);
});

test("POST /v1/keychain/enable: stores master key in keychain when unlocked", async () => {
  const keychain = new MockKeychain();
  await withKeychainDaemon(async (ctx) => {
    const { masterKey, envelopeId } = await bootstrapVault(ctx.services);

    const r = await call(ctx.port, "POST", "/v1/keychain/enable");
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
    assert.equal((r.body as { enrolled: boolean }).enrolled, true);

    // MockKeychain must hold the entry.
    const cached = await keychain.get("secret-shuttle", envelopeId);
    assert.ok(cached !== null, "keychain must have an entry");
    assert.deepEqual(cached, masterKey, "cached key must match master key");
  }, keychain);
});

test("POST /v1/keychain/enable: throws keychain_unavailable when no keychain", async () => {
  const keychain = new MockKeychain();
  keychain.available = false;
  await withKeychainDaemon(async (ctx) => {
    await bootstrapVault(ctx.services);

    const r = await call(ctx.port, "POST", "/v1/keychain/enable");
    assert.equal(r.status, 400);
    assert.equal((r.body as { error_code: string }).error_code, "keychain_unavailable");
  }, keychain);
});

// ── POST /v1/keychain/disable ───────────────────────────────────────────────

test("POST /v1/keychain/disable: removes entry (idempotent)", async () => {
  const keychain = new MockKeychain();
  await withKeychainDaemon(async (ctx) => {
    const { masterKey, envelopeId } = await bootstrapVault(ctx.services);

    // Pre-seed the keychain.
    await keychain.set("secret-shuttle", envelopeId, masterKey);
    assert.ok(await keychain.get("secret-shuttle", envelopeId) !== null, "entry must exist before disable");

    const r = await call(ctx.port, "POST", "/v1/keychain/disable");
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
    assert.equal((r.body as { removed: boolean }).removed, true);

    // Entry must be gone.
    const after = await keychain.get("secret-shuttle", envelopeId);
    assert.equal(after, null, "keychain entry must be removed after disable");
  }, keychain);
});

test("POST /v1/keychain/disable: no entry → still succeeds (no error)", async () => {
  const keychain = new MockKeychain(); // empty
  await withKeychainDaemon(async (ctx) => {
    await bootstrapVault(ctx.services);

    const r = await call(ctx.port, "POST", "/v1/keychain/disable");
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
    assert.equal((r.body as { removed: boolean }).removed, true);
  }, keychain);
});

test("POST /v1/keychain/disable: keychain unavailable → still succeeds (nothing to remove)", async () => {
  const keychain = new MockKeychain();
  keychain.available = false;
  await withKeychainDaemon(async (ctx) => {
    await bootstrapVault(ctx.services);

    const r = await call(ctx.port, "POST", "/v1/keychain/disable");
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
    assert.equal((r.body as { removed: boolean }).removed, true);
  }, keychain);
});

// ── GET /v1/keychain/status ─────────────────────────────────────────────────

test("GET /v1/keychain/status: no envelope → vault_id: null, enrolled: false", async () => {
  const keychain = new MockKeychain();
  await withKeychainDaemon(async (ctx) => {
    // No envelope on disk.
    const r = await call(ctx.port, "GET", "/v1/keychain/status");
    assert.equal(r.status, 200);
    assert.equal((r.body as { available: boolean }).available, true);
    assert.equal((r.body as { enrolled: boolean }).enrolled, false);
    assert.equal((r.body as { vault_id: string | null }).vault_id, null);
  }, keychain);
});

test("GET /v1/keychain/status: envelope but no enrollment → enrolled: false, vault_id set", async () => {
  const keychain = new MockKeychain(); // empty
  await withKeychainDaemon(async (ctx) => {
    const { envelopeId } = await bootstrapVault(ctx.services);

    const r = await call(ctx.port, "GET", "/v1/keychain/status");
    assert.equal(r.status, 200);
    assert.equal((r.body as { available: boolean }).available, true);
    assert.equal((r.body as { enrolled: boolean }).enrolled, false);
    assert.equal((r.body as { vault_id: string }).vault_id, envelopeId);
  }, keychain);
});

test("GET /v1/keychain/status: envelope + enrolled → enrolled: true, vault_id set", async () => {
  const keychain = new MockKeychain();
  await withKeychainDaemon(async (ctx) => {
    const { masterKey, envelopeId } = await bootstrapVault(ctx.services);
    await keychain.set("secret-shuttle", envelopeId, masterKey);

    const r = await call(ctx.port, "GET", "/v1/keychain/status");
    assert.equal(r.status, 200);
    assert.equal((r.body as { available: boolean }).available, true);
    assert.equal((r.body as { enrolled: boolean }).enrolled, true);
    assert.equal((r.body as { vault_id: string }).vault_id, envelopeId);
  }, keychain);
});
