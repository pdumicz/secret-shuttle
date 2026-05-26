import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureMachineId, resetMachineId, readMachineId } from "./machine-id.js";

function freshHome(): string {
  return mkdtempSync(path.join(tmpdir(), "ss-machineid-"));
}

test("ensureMachineId: generates 32-byte base64url file at 0600 when absent", async () => {
  const home = freshHome();
  const id = await ensureMachineId(home);
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  assert.equal(id.length, 43);
  assert.equal(Buffer.from(id, "base64url").byteLength, 32);
  const file = path.join(home, "machine-id");
  const st = statSync(file);
  assert.equal(st.mode & 0o777, 0o600);
});

test("ensureMachineId: reads existing file, does NOT regenerate", async () => {
  const home = freshHome();
  const first = await ensureMachineId(home);
  const second = await ensureMachineId(home);
  assert.equal(first, second);
});

test("ensureMachineId: throws machine_id_bad_mode when file exists at wrong mode", async () => {
  const home = freshHome();
  await ensureMachineId(home);
  chmodSync(path.join(home, "machine-id"), 0o644);
  await assert.rejects(
    () => ensureMachineId(home),
    (e: unknown) => (e as Error).message.includes("machine_id_bad_mode"),
  );
});

test("ensureMachineId: throws machine_id_malformed when content is wrong length/charset", async () => {
  const home = freshHome();
  writeFileSync(path.join(home, "machine-id"), "not-base64url!", { mode: 0o600 });
  await assert.rejects(
    () => ensureMachineId(home),
    (e: unknown) => (e as Error).message.includes("machine_id_malformed"),
  );
});

test("resetMachineId: deletes existing file and forces regeneration on next ensureMachineId", async () => {
  const home = freshHome();
  const first = await ensureMachineId(home);
  await resetMachineId(home);
  const second = await ensureMachineId(home);
  assert.notEqual(first, second);
});

test("readMachineId: returns null when absent", async () => {
  const home = freshHome();
  assert.equal(await readMachineId(home), null);
});
