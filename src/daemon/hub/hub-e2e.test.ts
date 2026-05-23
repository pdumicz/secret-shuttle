import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { DaemonServices } from "../services.js";
import { HubBroker, type HubEvent, type HubSubscriber } from "./hub-broker.js";
import { registerRoutes } from "../api/router.js";

interface E2ECtx {
  port: number;
  broker: HubBroker;
  services: DaemonServices;
  opens: string[];
  nowRef: { value: number };
}

async function withE2EDaemon<T>(fn: (ctx: E2ECtx) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-hub-e2e-"));
  const prevHome = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const opens: string[] = [];
  const nowRef = { value: 1_000_000 };
  const broker = new HubBroker({
    openUrlImpl: (u) => opens.push(u),
    now: () => nowRef.value,
  });
  const services = new DaemonServices({ hubBroker: broker });
  const server = new DaemonServer({ token: "t" });
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, broker, services, opens, nowRef });
  } finally {
    await server.close();
    if (prevHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prevHome;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

function makeSub(): { sub: HubSubscriber; events: HubEvent[]; closed: () => boolean } {
  const events: HubEvent[] = [];
  let isClosed = false;
  return {
    sub: { write: (e) => events.push(e), close: () => { isClosed = true; } },
    events,
    closed: () => isClosed,
  };
}

test("e2e: single approval via hub — spawn once, attach drains, markDone clears", async () => {
  await withE2EDaemon(async (ctx) => {
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t`, ctx.port);
    assert.equal(ctx.opens.length, 1, "exactly one spawn");
    assert.match(ctx.opens[0]!, /\/ui\/hub\?token=/);

    const { sub, events } = makeSub();
    ctx.broker.attach(sub);
    assert.equal(events.length, 1);
    const ev = events[0] as Extract<HubEvent, { type: "navigate" }>;
    assert.equal(ev.type, "navigate");
    assert.equal(new URL(ev.url).searchParams.get("hub_seq"), "1");
    assert.equal(ev.seq, 1);

    // Simulate iframe done via POST /ui/hub/done.
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 1 }),
    });
    assert.equal(r.status, 200);
    assert.equal(ctx.broker.peekState().activeUrl, null);
  });
});

test("e2e: burst while detached — exactly one spawn, FIFO drain on attach", async () => {
  await withE2EDaemon(async (ctx) => {
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t1`, ctx.port);
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=b&token=t2`, ctx.port);
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=c&token=t3`, ctx.port);
    assert.equal(ctx.opens.length, 1, "burst-debounce: one spawn");

    const { sub, events } = makeSub();
    ctx.broker.attach(sub);
    // First navigate is url1 (queue front promoted to active).
    assert.equal(events.length, 1);
    assert.match((events[0] as Extract<HubEvent, { type: "navigate" }>).url, /id=a/);

    ctx.broker.markDone(1);
    assert.match((events[1] as Extract<HubEvent, { type: "navigate" }>).url, /id=b/);
    ctx.broker.markDone(2);
    assert.match((events[2] as Extract<HubEvent, { type: "navigate" }>).url, /id=c/);
    ctx.broker.markDone(3);
    assert.equal(ctx.broker.peekState().activeUrl, null);
  });
});

test("e2e: tab-close mid-op + post-timeout recovery — 3 opens, resend then drain", async () => {
  await withE2EDaemon(async (ctx) => {
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t1`, ctx.port);
    assert.equal(ctx.opens.length, 1);

    const sub1 = makeSub();
    const detach1 = ctx.broker.attach(sub1.sub);
    assert.equal(sub1.events.length, 1);

    // Simulate hub close (SSE drop) — no markDone.
    detach1();
    assert.equal(ctx.broker.peekState().activeUrl, `http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t1`);

    // Surface url2 while detached and within spawn-debounce window? No —
    // attach() already cleared spawnInFlightSince, so this respawns.
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=b&token=t2`, ctx.port);
    assert.equal(ctx.opens.length, 2);

    // Advance synthetic clock past timeout.
    ctx.nowRef.value += 5001;

    // Surface url3 — !isSpawnInFlight (timeout) → respawn.
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=c&token=t3`, ctx.port);
    assert.equal(ctx.opens.length, 3);

    // Reattach: resend activeUrl (url1).
    const sub2 = makeSub();
    ctx.broker.attach(sub2.sub);
    assert.equal(sub2.events.length, 1);
    assert.match((sub2.events[0] as Extract<HubEvent, { type: "navigate" }>).url, /id=a/);

    ctx.broker.markDone(1);
    assert.match((sub2.events[1] as Extract<HubEvent, { type: "navigate" }>).url, /id=b/);
    ctx.broker.markDone(2);
    assert.match((sub2.events[2] as Extract<HubEvent, { type: "navigate" }>).url, /id=c/);
    ctx.broker.markDone(3);
  });
});

test("e2e: tab-close mid-op stays within spawn window — 2 opens, resend then drain", async () => {
  await withE2EDaemon(async (ctx) => {
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t1`, ctx.port);
    const sub1 = makeSub();
    const detach1 = ctx.broker.attach(sub1.sub);
    detach1();
    // attach() cleared spawnInFlightSince; this respawns.
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=b&token=t2`, ctx.port);
    assert.equal(ctx.opens.length, 2);
    // Stay within debounce window for url2's spawn.
    ctx.nowRef.value += 100;
    const sub2 = makeSub();
    ctx.broker.attach(sub2.sub);
    // Resend url1.
    assert.match((sub2.events[0] as Extract<HubEvent, { type: "navigate" }>).url, /id=a/);
    ctx.broker.markDone(1);
    assert.match((sub2.events[1] as Extract<HubEvent, { type: "navigate" }>).url, /id=b/);
  });
});

test("e2e: /ui/hub/done route smoke under retry-shaped traffic — idempotency holds", async () => {
  await withE2EDaemon(async (ctx) => {
    const { sub } = makeSub();
    ctx.broker.attach(sub);
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t`, ctx.port);
    const url = `http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`;
    const opts = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seq: 1 }) };
    const r1 = await fetch(url, opts);
    const r2 = await fetch(url, opts);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(ctx.broker.peekState().activeUrl, null);
  });
});

test("e2e: permanent postDone failure → SSE detach → respawn-on-next-surface", async () => {
  await withE2EDaemon(async (ctx) => {
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t1`, ctx.port);
    const sub1 = makeSub();
    const detach1 = ctx.broker.attach(sub1.sub);
    // Simulate the hub-side terminal branch: es.close() → daemon detach.
    detach1();
    assert.equal(ctx.broker.peekState().isAttached, false);
    assert.equal(ctx.broker.peekState().activeUrl, `http://127.0.0.1:${ctx.port}/ui/approve?id=a&token=t1`);

    // Surface url2 → respawn (subscriber gone, spawnInFlightSince null).
    ctx.broker.surface(`http://127.0.0.1:${ctx.port}/ui/approve?id=b&token=t2`, ctx.port);
    assert.equal(ctx.opens.length, 2);

    // New hub attaches → resend activeUrl (url1).
    const sub2 = makeSub();
    ctx.broker.attach(sub2.sub);
    assert.match((sub2.events[0] as Extract<HubEvent, { type: "navigate" }>).url, /id=a/);
  });
});
