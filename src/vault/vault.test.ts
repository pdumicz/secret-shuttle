import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getShuttlePaths } from "../shared/config.js";
import { Vault } from "./vault.js";

test("vault stores encrypted secrets and returns metadata only", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "secret-shuttle-test-"));
  const originalHome = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;

  try {
    const vault = new Vault();
    await vault.init();
    const metadata = await vault.upsertSecret({
      name: "STRIPE_WEBHOOK_SECRET",
      environment: "production",
      source: "stripe",
      value: "whsec_test_secret_value_123456789",
      allowedDomains: ["dashboard.stripe.com", "vercel.com"],
    });

    assert.equal(metadata.ref, "ss://stripe/prod/STRIPE_WEBHOOK_SECRET");
    assert.equal(metadata.value_visible_to_agent, false);
    assert.equal("value" in metadata, false);

    const listed = await vault.list({ environment: "production" });
    assert.equal(listed.length, 1);
    assert.equal("value" in listed[0]!, false);

    const paths = getShuttlePaths(home);
    const rawVaultFile = await readFile(paths.vaultPath, "utf8");
    assert.equal(rawVaultFile.includes("whsec_test_secret_value_123456789"), false);
    assert.equal(rawVaultFile.includes("STRIPE_WEBHOOK_SECRET"), false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.SECRET_SHUTTLE_HOME;
    } else {
      process.env.SECRET_SHUTTLE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
