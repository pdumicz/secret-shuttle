import { test } from "node:test";
import assert from "node:assert/strict";
import { getKeychainAdapter } from "./index.js";
import { DarwinKeychain } from "./darwin.js";
import { LinuxKeychain } from "./linux.js";
import { WindowsKeychain } from "./windows.js";
import { ShuttleError } from "../../shared/errors.js";

// node:test `skip` accepts `boolean | string`. Use `false` (don't skip)
// rather than `null` — `null` is not assignable to that type under strict
// TypeScript, which would break the build.
const skipUnlessDarwin = process.platform !== "darwin" ? "not darwin" : false;
const skipUnlessLinux = process.platform !== "linux" ? "not linux" : false;
const skipUnlessWin32 = process.platform !== "win32" ? "not win32" : false;

test("getKeychainAdapter returns DarwinKeychain on darwin", { skip: skipUnlessDarwin }, () => {
  const adapter = getKeychainAdapter();
  assert.ok(adapter instanceof DarwinKeychain);
});

test("getKeychainAdapter returns LinuxKeychain on linux", { skip: skipUnlessLinux }, () => {
  const adapter = getKeychainAdapter();
  assert.ok(adapter instanceof LinuxKeychain);
});

test("getKeychainAdapter returns WindowsKeychain on win32", { skip: skipUnlessWin32 }, () => {
  const adapter = getKeychainAdapter();
  assert.ok(adapter instanceof WindowsKeychain);
});

test("getKeychainAdapter respects platform override", () => {
  const dk = getKeychainAdapter({ platformOverride: "darwin" });
  assert.ok(dk instanceof DarwinKeychain);
  const lk = getKeychainAdapter({ platformOverride: "linux" });
  assert.ok(lk instanceof LinuxKeychain);
  const wk = getKeychainAdapter({ platformOverride: "win32" });
  assert.ok(wk instanceof WindowsKeychain);
});

// Stub-behavior assertions: every Plan-1 platform adapter MUST report
// not-available and throw keychain_not_implemented on every operation.
for (const [name, platform] of [
  ["darwin", "darwin"],
  ["linux", "linux"],
  ["win32", "win32"],
] as const) {
  test(`${name} stub: isAvailable() returns false`, async () => {
    const adapter = getKeychainAdapter({ platformOverride: platform });
    assert.equal(await adapter.isAvailable(), false);
  });

  test(`${name} stub: set() throws keychain_not_implemented`, async () => {
    const adapter = getKeychainAdapter({ platformOverride: platform });
    await assert.rejects(
      () => adapter.set("svc", "acct", Buffer.from("x")),
      (err) => err instanceof ShuttleError && err.code === "keychain_not_implemented",
    );
  });

  test(`${name} stub: get() throws keychain_not_implemented`, async () => {
    const adapter = getKeychainAdapter({ platformOverride: platform });
    await assert.rejects(
      () => adapter.get("svc", "acct"),
      (err) => err instanceof ShuttleError && err.code === "keychain_not_implemented",
    );
  });

  test(`${name} stub: delete() throws keychain_not_implemented`, async () => {
    const adapter = getKeychainAdapter({ platformOverride: platform });
    await assert.rejects(
      () => adapter.delete("svc", "acct"),
      (err) => err instanceof ShuttleError && err.code === "keychain_not_implemented",
    );
  });
}

test("getKeychainAdapter on unsupported platform: stub-shaped + refuses operations", async () => {
  const adapter = getKeychainAdapter({ platformOverride: "freebsd" as NodeJS.Platform });
  // Shape:
  assert.equal(typeof adapter.isAvailable, "function");
  assert.equal(typeof adapter.set, "function");
  assert.equal(typeof adapter.get, "function");
  assert.equal(typeof adapter.delete, "function");
  // Behavior:
  assert.equal(await adapter.isAvailable(), false);
  await assert.rejects(
    () => adapter.set("svc", "acct", Buffer.from("x")),
    (err) => err instanceof ShuttleError && err.code === "keychain_not_implemented",
  );
  await assert.rejects(
    () => adapter.get("svc", "acct"),
    (err) => err instanceof ShuttleError && err.code === "keychain_not_implemented",
  );
  await assert.rejects(
    () => adapter.delete("svc", "acct"),
    (err) => err instanceof ShuttleError && err.code === "keychain_not_implemented",
  );
});
