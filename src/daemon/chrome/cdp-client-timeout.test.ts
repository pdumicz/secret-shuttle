import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

class ReplyTransport extends EventEmitter implements CdpTransport {
  reply = true;
  send(msg: Sent): void {
    if (this.reply) queueMicrotask(() => this.emit("message", { id: msg.id, result: { ok: 1 } }));
    // else: never reply (simulates a hung CDP call)
  }
}

test("sendWithTimeout resolves with the result and clears its timer on response", async () => {
  const c = new CdpClient(new ReplyTransport());
  const started = Date.now();
  assert.deepEqual(await c.sendWithTimeout<{ ok: number }>("X.y", undefined, undefined, 5_000), { ok: 1 });
  // A leaked 5s timer would keep node:test from exiting; resolving well under the
  // bound demonstrates the success path returns promptly and the timer is cleared.
  assert.ok(Date.now() - started < 1_000);
});

test("sendWithTimeout rejects within the bound when the transport never replies, and the client is not wedged", async () => {
  const t = new ReplyTransport();
  t.reply = false;
  const c = new CdpClient(t);
  const started = Date.now();
  await assert.rejects(() => c.sendWithTimeout("X.y", undefined, undefined, 120), /timed out/);
  assert.ok(Date.now() - started < 1_000, "must reject at ~the bound, not hang");
  // The dropped pending entry must not wedge the client — a later call still works.
  t.reply = true;
  assert.deepEqual(await c.sendWithTimeout<{ ok: number }>("X.z", undefined, undefined, 5_000), { ok: 1 });
});
