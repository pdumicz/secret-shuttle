import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapStore, type BatchState } from "./store.js";

function makeState(id: string): BatchState {
  return {
    batch_id: id,
    approval_id: "approval-" + id,
    plan_file_path: "/tmp/secret-shuttle.yml",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
  };
}

test("BootstrapStore: create + get round-trip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  const state = makeState("a");
  await store.save(state);
  const got = await store.get("a");
  assert.deepStrictEqual(got, state);
});

test("BootstrapStore: get(unknown) returns null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  assert.strictEqual(await store.get("missing"), null);
});

test("BootstrapStore: persists to disk in mode-0600 file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save(makeState("b"));
  const files = await readdir(dir);
  assert.ok(files.includes("b.json"));
  const content = JSON.parse(await readFile(path.join(dir, "b.json"), "utf8"));
  assert.strictEqual(content.batch_id, "b");
});

test("BootstrapStore: list returns all states", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save(makeState("x"));
  await store.save(makeState("y"));
  const list = await store.list();
  const ids = list.map((s) => s.batch_id).sort();
  assert.deepStrictEqual(ids, ["x", "y"]);
});

test("BootstrapStore: delete removes from store + disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  await store.save(makeState("c"));
  await store.delete("c");
  assert.strictEqual(await store.get("c"), null);
  const files = await readdir(dir);
  assert.ok(!files.includes("c.json"));
});

test("BootstrapStore: pruneOlderThan removes stale batches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ss-bootstrap-"));
  const store = new BootstrapStore({ rootDir: dir });
  const old = makeState("old");
  old.created_at = Date.now() - 48 * 3600 * 1000; // 48h ago
  const fresh = makeState("fresh");
  await store.save(old);
  await store.save(fresh);
  await store.pruneOlderThan(24 * 3600 * 1000); // 24h threshold
  assert.strictEqual(await store.get("old"), null);
  assert.ok((await store.get("fresh")) !== null);
});
