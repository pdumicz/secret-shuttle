import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
import { assertSafeExecutable } from "./safe-executable.js";

test("rejects relative paths", async () => {
  await assert.rejects(
    () => assertSafeExecutable("node"),
    (e) => e instanceof ShuttleError && e.code === "unsafe_binary_path",
  );
});

test("rejects a path under the current workspace", async () => {
  await assert.rejects(
    () => assertSafeExecutable(path.join(process.cwd(), "some-bin")),
    (e) => e instanceof ShuttleError && e.code === "unsafe_binary_path",
  );
});

test("accepts an absolute system binary and returns its realpath", async () => {
  const resolved = await assertSafeExecutable(process.execPath);
  assert.ok(path.isAbsolute(resolved));
});

test("rejects a world-writable file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-safe-"));
  const f = path.join(dir, "ww");
  await writeFile(f, "x");
  await chmod(f, 0o777);
  try {
    await assert.rejects(
      () => assertSafeExecutable(f),
      (e) => e instanceof ShuttleError && e.code === "unsafe_binary_path",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("enforces a SHA-256 pin", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-safe-"));
  const f = path.join(dir, "bin");
  await writeFile(f, "hello");
  await chmod(f, 0o755);
  const good = createHash("sha256").update("hello").digest("hex");
  try {
    const { realpath } = await import("node:fs/promises");
    assert.equal(await assertSafeExecutable(f, { expectedSha256: good }), await realpath(f));
    await assert.rejects(
      () => assertSafeExecutable(f, { expectedSha256: "0".repeat(64) }),
      (e) => e instanceof ShuttleError && e.code === "binary_hash_mismatch",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
