import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
import { LockedVaultState } from "./locked-state.js";

test("locked state starts locked and rejects key reads", () => {
  const s = new LockedVaultState();
  assert.equal(s.isUnlocked(), false);
  assert.throws(
    () => s.requireKey(),
    (err) => err instanceof ShuttleError && err.code === "vault_locked",
  );
});

test("unlocking and locking flip state", () => {
  const s = new LockedVaultState();
  s.unlock(Buffer.alloc(32, 1));
  assert.equal(s.isUnlocked(), true);
  assert.equal(s.requireKey().byteLength, 32);
  s.lock();
  assert.equal(s.isUnlocked(), false);
});
