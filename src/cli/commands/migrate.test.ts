import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encryptVault, createMasterKey, encodeKey } from "../../vault/crypto.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cli/index.js");

function runCli(args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("migrate secure-vault converts v1 key to v2 envelope and deletes master-key.json", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-mig-"));
  const env: NodeJS.ProcessEnv = { ...process.env, SECRET_SHUTTLE_HOME: home };
  try {
    const key = createMasterKey();
    // Write v1 master-key.json.
    await writeFile(path.join(home, "master-key.json"), JSON.stringify({
      version: 1, algorithm: "aes-256-gcm", key: encodeKey(key), storage: "local-file", warning: "x",
    }), { encoding: "utf8", mode: 0o600 });
    // Write v1 vault (empty secrets list).
    await writeFile(
      path.join(home, "vault.json.enc"),
      JSON.stringify(encryptVault({ version: 1, secrets: [] }, key)),
    );

    const r = await runCli(["migrate", "secure-vault"], env, "passphrase\npassphrase\n");
    assert.equal(r.code, 0);

    // master-key.json should be gone.
    await assert.rejects(() => stat(path.join(home, "master-key.json")));

    // key-envelope.json should exist with version 2.
    const env2 = JSON.parse(await readFile(path.join(home, "key-envelope.json"), "utf8")) as { version: number };
    assert.equal(env2.version, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrate secure-vault fails when passphrases differ", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-mig-fail-"));
  const env: NodeJS.ProcessEnv = { ...process.env, SECRET_SHUTTLE_HOME: home };
  try {
    const key = createMasterKey();
    await writeFile(path.join(home, "master-key.json"), JSON.stringify({
      version: 1, algorithm: "aes-256-gcm", key: encodeKey(key), storage: "local-file", warning: "x",
    }), { encoding: "utf8", mode: 0o600 });
    await writeFile(
      path.join(home, "vault.json.enc"),
      JSON.stringify(encryptVault({ version: 1, secrets: [] }, key)),
    );

    const r = await runCli(["migrate", "secure-vault"], env, "one\ntwo\n");
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes("passphrase_mismatch") || r.stderr.includes("passphrases"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrate secure-vault refuses when an envelope already exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-mig-already-"));
  const env: NodeJS.ProcessEnv = { ...process.env, SECRET_SHUTTLE_HOME: home };
  try {
    await writeFile(path.join(home, "key-envelope.json"), JSON.stringify({
      version: 2, kdf: "scrypt", kdfParams: { N: 32768, r: 8, p: 1 },
      salt: "x", algorithm: "aes-256-gcm", nonce: "x", authTag: "x", ciphertext: "x", created_at: new Date().toISOString(),
    }));

    const r = await runCli(["migrate", "secure-vault"], env, "");
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes("already_migrated"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
