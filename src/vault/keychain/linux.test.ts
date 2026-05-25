import { test } from "node:test";
import assert from "node:assert";
import { LinuxKeychain } from "./linux.js";

const skip = process.env.CI_ALLOW_KEYCHAIN !== "1" || process.platform !== "linux";
const TEST_SERVICE = "secret-shuttle-test-linux";

test("LinuxKeychain: isAvailable returns boolean honestly", { skip }, async () => {
  const k = new LinuxKeychain();
  // libsecret may not be present in minimal containers. The method must
  // return a boolean either way — never throw.
  const avail = await k.isAvailable();
  assert.strictEqual(typeof avail, "boolean");
});

test("LinuxKeychain: set + get round-trips a Buffer (skips if libsecret absent)", { skip }, async (t) => {
  const k = new LinuxKeychain();
  if (!(await k.isAvailable())) {
    t.skip("libsecret not available");
    return;
  }
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

test("LinuxKeychain: get returns null when no entry exists", { skip }, async (t) => {
  const k = new LinuxKeychain();
  if (!(await k.isAvailable())) {
    t.skip("libsecret not available");
    return;
  }
  assert.strictEqual(await k.get(TEST_SERVICE, `nonexistent-${Date.now()}`), null);
});

test("LinuxKeychain: delete is idempotent", { skip }, async (t) => {
  const k = new LinuxKeychain();
  if (!(await k.isAvailable())) {
    t.skip("libsecret not available");
    return;
  }
  await k.delete(TEST_SERVICE, `nonexistent-${Date.now()}`);
});

test("LinuxKeychain: delete actually removes the entry", { skip }, async (t) => {
  const k = new LinuxKeychain();
  if (!(await k.isAvailable())) {
    t.skip("libsecret not available");
    return;
  }
  const account = `delete-test-${Date.now()}`;
  await k.set(TEST_SERVICE, account, Buffer.from("test"));
  assert.ok((await k.get(TEST_SERVICE, account)) !== null);
  await k.delete(TEST_SERVICE, account);
  assert.strictEqual(await k.get(TEST_SERVICE, account), null);
});
