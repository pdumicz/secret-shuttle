import { test } from "node:test";
import assert from "node:assert";
import { DarwinKeychain } from "./darwin.js";

const skip = process.env.CI_ALLOW_KEYCHAIN !== "1" || process.platform !== "darwin";
const TEST_SERVICE = "secret-shuttle-test-darwin";

test("DarwinKeychain: isAvailable returns true on macOS with @napi-rs/keyring loaded", { skip }, async () => {
  const k = new DarwinKeychain();
  assert.strictEqual(await k.isAvailable(), true);
});

test("DarwinKeychain: set + get round-trips a Buffer", { skip }, async () => {
  const k = new DarwinKeychain();
  const account = `roundtrip-${Date.now()}`;
  const value = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  try {
    await k.set(TEST_SERVICE, account, value);
    const got = await k.get(TEST_SERVICE, account);
    assert.ok(got !== null);
    assert.deepStrictEqual(got, value);
  } finally {
    await k.delete(TEST_SERVICE, account).catch(() => undefined);
  }
});

test("DarwinKeychain: get returns null when no entry exists", { skip }, async () => {
  const k = new DarwinKeychain();
  const got = await k.get(TEST_SERVICE, `nonexistent-${Date.now()}`);
  assert.strictEqual(got, null);
});

test("DarwinKeychain: delete is idempotent (no-op for missing entry)", { skip }, async () => {
  const k = new DarwinKeychain();
  // Should not throw.
  await k.delete(TEST_SERVICE, `nonexistent-${Date.now()}`);
});

test("DarwinKeychain: delete actually removes the entry", { skip }, async () => {
  const k = new DarwinKeychain();
  const account = `delete-test-${Date.now()}`;
  await k.set(TEST_SERVICE, account, Buffer.from("test"));
  assert.ok((await k.get(TEST_SERVICE, account)) !== null);
  await k.delete(TEST_SERVICE, account);
  assert.strictEqual(await k.get(TEST_SERVICE, account), null);
});
