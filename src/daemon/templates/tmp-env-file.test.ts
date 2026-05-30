import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeSecretEnvFile, unlinkSecretEnvFile } from "./tmp-env-file.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-tef-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeSecretEnvFile creates a file with mode 0600 and exactly NAME=VALUE\\n", async () => {
  await withTmp(async (dir) => {
    const { path: p } = writeSecretEnvFile({ name: "MY_SECRET", value: Buffer.from("v3rySecret!", "utf8"), tmpDir: dir });
    const st = await stat(p);
    assert.equal(st.mode & 0o777, 0o600, "file mode must be 0600");
    const content = await readFile(p, "utf8");
    assert.equal(content, "MY_SECRET=v3rySecret!\n");
  });
});

test("writeSecretEnvFile returns a path inside the supplied tmpDir with a randomized name", async () => {
  await withTmp(async (dir) => {
    const a = writeSecretEnvFile({ name: "X", value: Buffer.from("1", "utf8"), tmpDir: dir });
    const b = writeSecretEnvFile({ name: "X", value: Buffer.from("1", "utf8"), tmpDir: dir });
    assert.notEqual(a.path, b.path, "filenames must be randomized to avoid collisions");
    assert.equal(path.dirname(a.path), dir);
    assert.match(path.basename(a.path), /^[0-9a-f]{32}\.env$/);
  });
});

test("writeSecretEnvFile O_EXCL refuses an existing path (synthetic collision)", async () => {
  await withTmp(async (dir) => {
    const { writeSecretEnvFileAt } = await import("./tmp-env-file.js");
    const fixed = path.join(dir, "fixed.env");
    await writeFile(fixed, "pre-existing\n");
    assert.throws(
      () => writeSecretEnvFileAt({ name: "X", value: Buffer.from("1", "utf8"), path: fixed }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "template_env_file_collision",
    );
  });
});

test("writeSecretEnvFile scrubs the secret buffer it owns (caller's string is not held)", async () => {
  await withTmp(async (dir) => {
    const result = writeSecretEnvFile({ name: "X", value: Buffer.from("leak-detector-7f", "utf8"), tmpDir: dir });
    assert.deepEqual(Object.keys(result).sort(), ["path"]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("leak-detector-7f"), false);
  });
});

test("unlinkSecretEnvFile deletes an existing file", async () => {
  await withTmp(async (dir) => {
    const { path: p } = writeSecretEnvFile({ name: "X", value: Buffer.from("1", "utf8"), tmpDir: dir });
    unlinkSecretEnvFile(p);
    await assert.rejects(() => stat(p), (e: unknown) => (e as { code?: string }).code === "ENOENT");
  });
});

test("unlinkSecretEnvFile is ENOENT-tolerant (no throw on missing)", async () => {
  await withTmp(async (dir) => {
    const ghost = path.join(dir, "does-not-exist.env");
    assert.doesNotThrow(() => unlinkSecretEnvFile(ghost));
  });
});

test("writeSecretEnvFile rejects a name containing '=' or newline (env-file injection guard)", async () => {
  await withTmp(async (dir) => {
    assert.throws(
      () => writeSecretEnvFile({ name: "X=Y", value: Buffer.from("v", "utf8"), tmpDir: dir }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "invalid_env_var_name",
    );
    assert.throws(
      () => writeSecretEnvFile({ name: "X\nY", value: Buffer.from("v", "utf8"), tmpDir: dir }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "invalid_env_var_name",
    );
  });
});
