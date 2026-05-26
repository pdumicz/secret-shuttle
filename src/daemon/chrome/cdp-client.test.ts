import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";

class FakeTransport extends EventEmitter implements CdpTransport {
  closeCalls = 0;
  send(msg: { id?: number; method?: string }): void {
    queueMicrotask(() => {
      if (msg.method === "Browser.getVersion") {
        this.emit("message", { id: msg.id, result: { product: "Test/0" } });
      } else if (msg.method === "Failing.method") {
        this.emit("message", { id: msg.id, error: { code: -1, message: "nope" } });
      }
    });
  }
  close(): void { this.closeCalls += 1; }
}

test("send resolves on response", async () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  const r = await c.send("Browser.getVersion");
  assert.deepEqual(r, { product: "Test/0" });
});

test("send rejects on error", async () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  await assert.rejects(() => c.send("Failing.method"), /nope/);
});

test("on() receives method events", async () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  let received: unknown = null;
  c.on("Target.targetCreated", (p) => { received = p; });
  t.emit("message", { method: "Target.targetCreated", params: { hello: "world" } });
  assert.deepEqual(received, { hello: "world" });
});

test("off() removes a listener so later events are not delivered", () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  let count = 0;
  const fn = (): void => { count += 1; };
  c.on("Target.targetCreated", fn);
  t.emit("message", { method: "Target.targetCreated", params: {} });
  c.off("Target.targetCreated", fn);
  t.emit("message", { method: "Target.targetCreated", params: {} });
  assert.equal(count, 1);
});

test("off() is a no-op for an unknown event or unregistered fn", () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  assert.doesNotThrow(() => c.off("Nope.event", () => {}));
  c.on("E", () => {});
  assert.doesNotThrow(() => c.off("E", () => {}));
});

test("close() tears down the transport and rejects pending sends with cdp_client_closed", async () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  // Page.enable is not scripted to reply → leaves a pending entry.
  const sendPromise = c.send("Page.enable");
  await c.close();
  await assert.rejects(sendPromise, (e: unknown) => (e as Error).message === "cdp_client_closed");
  assert.equal(t.closeCalls, 1);
});

test("close() makes subsequent send / sendWithTimeout reject immediately with cdp_client_closed", async () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  await c.close();
  await assert.rejects(() => c.send("Page.enable"), (e: unknown) => (e as Error).message === "cdp_client_closed");
  await assert.rejects(
    () => c.sendWithTimeout("Page.enable", undefined, undefined, 1_000),
    (e: unknown) => (e as Error).message === "cdp_client_closed",
  );
});

test("close() is idempotent — a second call does not double-close the transport", async () => {
  const t = new FakeTransport();
  const c = new CdpClient(t);
  await c.close();
  await c.close();
  assert.equal(t.closeCalls, 1);
});
