import assert from "node:assert/strict";
import test from "node:test";
import { BrowserHandleStore } from "./browser-handles.js";

function baseInput(label = "submit-button") {
  return {
    label,
    target_id: "T-1",
    domain: "vercel.com",
    page_url_host: "vercel.com",
    page_title: "Project",
    backend_node_id: 42,
    handle_fingerprint: "sha256:abc123",
    element_kind: "button" as const,
  };
}

test("put returns an opaque handle with TTL and is retrievable by label", () => {
  let now = 1_000;
  const store = new BrowserHandleStore({ now: () => now });
  const h = store.put(baseInput());
  assert.equal(h.label, "submit-button");
  assert.equal(typeof h.handle_id, "string");
  assert.notEqual(h.handle_id, "");
  assert.equal(h.created_at, 1_000);
  assert.equal(h.expires_at, 1_000 + 5 * 60 * 1000);
  assert.equal(store.get("submit-button")?.handle_id, h.handle_id);
});

test("re-marking a label is last-write-wins", () => {
  const store = new BrowserHandleStore({ now: () => 0 });
  const a = store.put(baseInput());
  const b = store.put({ ...baseInput(), backend_node_id: 99 });
  assert.notEqual(a.handle_id, b.handle_id);
  assert.equal(store.get("submit-button")?.handle_id, b.handle_id);
  assert.equal(store.get("submit-button")?.backend_node_id, 99);
  assert.equal(store.list().length, 1);
});

test("expired handles are treated as absent (fail closed) and pruned", () => {
  let now = 0;
  const store = new BrowserHandleStore({ now: () => now });
  store.put(baseInput());
  now = 5 * 60 * 1000 + 1;
  assert.equal(store.get("submit-button"), undefined);
  assert.equal(store.list().length, 0);
});

test("clear() empties the store (browser-session reset)", () => {
  const store = new BrowserHandleStore({ now: () => 0 });
  store.put(baseInput("a"));
  store.put(baseInput("b"));
  assert.equal(store.list().length, 2);
  store.clear();
  assert.equal(store.list().length, 0);
});
