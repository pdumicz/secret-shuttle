import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";
import { ensureRootToken, rotateRootToken } from "./root-token.js";

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), "ss-roottok-"));
}

test("ensureRootToken: generates 43-char base64url file at 0600 when absent", async () => {
  const home = freshHome();
  const t = await ensureRootToken(home);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.equal(t.length, 43);
  assert.equal(Buffer.from(t, "base64url").byteLength, 32);
  const st = statSync(path.join(home, "root-token"));
  assert.equal(st.mode & 0o777, 0o600);
});

test("ensureRootToken: reads existing file, does NOT regenerate", async () => {
  const home = freshHome();
  const first = await ensureRootToken(home);
  const second = await ensureRootToken(home);
  assert.equal(first, second);
});

test("ensureRootToken: throws ShuttleError(root_token_bad_mode) at wrong mode", async () => {
  const home = freshHome();
  await ensureRootToken(home);
  chmodSync(path.join(home, "root-token"), 0o644);
  await assert.rejects(
    () => ensureRootToken(home),
    (e: unknown) => e instanceof ShuttleError && e.code === "root_token_bad_mode",
  );
});

test("ensureRootToken: throws ShuttleError(root_token_malformed) when content fails 43-char/base64url check", async () => {
  const home = freshHome();
  writeFileSync(path.join(home, "root-token"), "not-base64url!", { mode: 0o600 });
  await assert.rejects(
    () => ensureRootToken(home),
    (e: unknown) => e instanceof ShuttleError && e.code === "root_token_malformed",
  );
});

test("rotateRootToken: atomically replaces with a new value, persists on next ensure", async () => {
  const home = freshHome();
  const first = await ensureRootToken(home);
  const second = await rotateRootToken(home);
  assert.notEqual(first, second);
  const third = await ensureRootToken(home);
  assert.equal(second, third);
});
