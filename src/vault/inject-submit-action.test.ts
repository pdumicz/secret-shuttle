import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Vault } from "./vault.js";

async function withVault<T>(fn: (v: Vault) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-isa-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const key = randomBytes(32);
    // Match production contract: keyProvider must return a fresh copy on each
    // call (Vault.read/write now scrub the returned Buffer in finally).
    const vault = new Vault(() => Buffer.from(key));
    await vault.ensureInitialized();
    return await fn(vault);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("a newly created secret gets inject_submit in the extended default action set", async () => {
  await withVault(async (vault) => {
    const meta = await vault.upsertSecret({
      name: "WEBHOOK", environment: "production", source: "stripe",
      value: "whsec_v1", allowedDomains: ["dashboard.stripe.com"],
    });
    assert.deepEqual(meta.allowed_actions, [
      "capture_from_page", "inject_into_field",
      "compare_fingerprint", "use_as_stdin", "inject_submit",
    ]);
  });
});

test("an explicitly-scoped secret persists exactly those actions (no implicit inject_submit grant)", async () => {
  await withVault(async (vault) => {
    await vault.upsertSecret({
      name: "LEGACY", environment: "production", source: "stripe",
      value: "whsec_legacy", allowedDomains: ["dashboard.stripe.com"],
      allowedActions: ["capture_from_page", "inject_into_field", "compare_fingerprint", "use_as_stdin"],
    });
    const rec = await vault.getSecret("ss://stripe/prod/LEGACY");
    assert.equal(rec.allowed_actions.includes("inject_submit"), false);
    assert.equal(rec.allowed_actions.includes("inject_into_field"), true);
  });
});

test("overwrite preserves existing allowed_actions when the caller omits them (no silent widening on force-rotate)", async () => {
  await withVault(async (vault) => {
    await vault.upsertSecret({
      name: "ROT", environment: "production", source: "stripe",
      value: "v1", allowedDomains: ["dashboard.stripe.com"],
      allowedActions: ["inject_into_field"],
    });
    // force-rotate WITHOUT specifying allowedActions — must NOT acquire the extended default.
    await vault.upsertSecret({
      name: "ROT", environment: "production", source: "stripe",
      value: "v2", allowedDomains: ["dashboard.stripe.com"], force: true,
    });
    const rec = await vault.getSecret("ss://stripe/prod/ROT");
    assert.deepEqual(rec.allowed_actions, ["inject_into_field"]);
    assert.equal(rec.value, "v2");
  });
});

test("an explicit caller-supplied allowedActions still wins on overwrite (explicit opt-in path)", async () => {
  await withVault(async (vault) => {
    await vault.upsertSecret({
      name: "OPT", environment: "production", source: "stripe",
      value: "v1", allowedDomains: ["dashboard.stripe.com"],
      allowedActions: ["inject_into_field"],
    });
    await vault.upsertSecret({
      name: "OPT", environment: "production", source: "stripe",
      value: "v1", allowedDomains: ["dashboard.stripe.com"], force: true,
      allowedActions: ["inject_into_field", "inject_submit"],
    });
    const rec = await vault.getSecret("ss://stripe/prod/OPT");
    assert.equal(rec.allowed_actions.includes("inject_submit"), true);
  });
});
