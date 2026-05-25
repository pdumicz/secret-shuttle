import { test } from "node:test";
import assert from "node:assert";
import { WindowsKeychain } from "./windows.js";

const skip = process.env.CI_ALLOW_KEYCHAIN !== "1" || process.platform !== "win32";
const TEST_SERVICE = "secret-shuttle-test-windows";

test("WindowsKeychain: isAvailable returns true on Windows with @napi-rs/keyring loaded", { skip }, async () => {
  const k = new WindowsKeychain();
  assert.strictEqual(await k.isAvailable(), true);
});

test("WindowsKeychain: set + get round-trips a Buffer", { skip }, async () => {
  const k = new WindowsKeychain();
  const account = `roundtrip-${Date.now()}`;
  const value = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  try {
    await k.set(TEST_SERVICE, account, value);
    const got = await k.get(TEST_SERVICE, account);
    assert.deepStrictEqual(got, value);
  } finally {
    await k.delete(TEST_SERVICE, account).catch(() => undefined);
  }
});

test("WindowsKeychain: get returns null when no entry exists", { skip }, async () => {
  const k = new WindowsKeychain();
  assert.strictEqual(await k.get(TEST_SERVICE, `nonexistent-${Date.now()}`), null);
});

test("WindowsKeychain: delete is idempotent", { skip }, async () => {
  const k = new WindowsKeychain();
  await k.delete(TEST_SERVICE, `nonexistent-${Date.now()}`);
});

test("WindowsKeychain: delete actually removes the entry", { skip }, async () => {
  const k = new WindowsKeychain();
  const account = `delete-test-${Date.now()}`;
  await k.set(TEST_SERVICE, account, Buffer.from("test"));
  assert.ok((await k.get(TEST_SERVICE, account)) !== null);
  await k.delete(TEST_SERVICE, account);
  assert.strictEqual(await k.get(TEST_SERVICE, account), null);
});
