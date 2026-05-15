import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasLegacyKeyFile, readLegacyKey } from "./keychain.js";
import { ShuttleError } from "../shared/errors.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-legacy-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("hasLegacyKeyFile is false when no file exists", async () => {
  await withHome(async () => {
    assert.equal(await hasLegacyKeyFile(), false);
  });
});

test("hasLegacyKeyFile is true when master-key.json exists", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "master-key.json"), JSON.stringify({
      version: 1, algorithm: "aes-256-gcm", key: "x", storage: "local-file", warning: "y",
    }));
    assert.equal(await hasLegacyKeyFile(), true);
  });
});

test("readLegacyKey returns null when no file exists", async () => {
  await withHome(async () => {
    assert.equal(await readLegacyKey(), null);
  });
});

test("readLegacyKey decodes the v1 key", async () => {
  await withHome(async (home) => {
    // a valid 32-byte base64url key
    const key = Buffer.alloc(32, 9);
    await writeFile(path.join(home, "master-key.json"), JSON.stringify({
      version: 1, algorithm: "aes-256-gcm", key: key.toString("base64url"),
      storage: "local-file", warning: "y",
    }));
    const out = await readLegacyKey();
    assert.deepEqual(out, key);
  });
});

test("readLegacyKey rejects unsupported format", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, "master-key.json"), JSON.stringify({
      version: 2, algorithm: "aes-256-gcm", key: Buffer.alloc(32).toString("base64url"),
      storage: "local-file", warning: "y",
    }));
    await assert.rejects(
      () => readLegacyKey(),
      (err) => err instanceof ShuttleError && err.code === "unsupported_key_storage",
    );
  });
});
