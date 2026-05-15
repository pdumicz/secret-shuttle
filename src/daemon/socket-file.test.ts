import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSocketFile, removeSocketFile, writeSocketFile } from "./socket-file.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-sock-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try { await fn(home); }
  finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("writeSocketFile writes JSON with mode 0o600", async () => {
  await withHome(async (home) => {
    await writeSocketFile({ port: 5511, token: "abc", pid: 1234 });
    assert.deepEqual(await readSocketFile(), { port: 5511, token: "abc", pid: 1234 });
    const info = await stat(path.join(home, "daemon-socket.json"));
    assert.equal(info.mode & 0o777, 0o600);
  });
});

test("readSocketFile returns null when missing", async () => {
  await withHome(async () => {
    assert.equal(await readSocketFile(), null);
  });
});

test("removeSocketFile is idempotent", async () => {
  await withHome(async () => {
    await removeSocketFile();
    await writeSocketFile({ port: 1, token: "t", pid: 1 });
    await removeSocketFile();
    assert.equal(await readSocketFile(), null);
  });
});
