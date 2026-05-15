import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";

class FakeTransport extends EventEmitter implements CdpTransport {
  send(msg: { id?: number; method?: string }): void {
    queueMicrotask(() => {
      if (msg.method === "Browser.getVersion") {
        this.emit("message", { id: msg.id, result: { product: "Test/0" } });
      } else if (msg.method === "Failing.method") {
        this.emit("message", { id: msg.id, error: { code: -1, message: "nope" } });
      }
    });
  }
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
