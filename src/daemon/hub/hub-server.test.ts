import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HubBroker } from "./hub-broker.js";
import { DaemonServer } from "../server.js";
import { registerHubRoutes } from "./hub-server.js";

async function withHubDaemon<T>(
  fn: (ctx: { port: number; broker: HubBroker; server: DaemonServer }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-hub-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const server = new DaemonServer({ token: "t" });
  // HubBroker.openUrlImpl is required (Task A1); a no-op opener is fine
  // here because Task B1's tests only exercise the route surface, not the
  // surface()-driven spawn path.
  const broker = new HubBroker({ openUrlImpl: () => undefined });
  registerHubRoutes(server, broker);
  const { port } = await server.listen(0);
  try {
    return await fn({ port, broker, server });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("GET /ui/hub with valid token → 200, text/html, hardening + CSP headers", async () => {
  await withHubDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub?token=${encodeURIComponent(ctx.broker.hubToken())}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    const html = await res.text();
    assert.ok(html.includes("Secret Shuttle Hub") || html.includes("hub"), "expected hub HTML");
  });
});

test("GET /ui/hub with wrong token → 401 ui_token_mismatch", async () => {
  await withHubDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub?token=WRONG`);
    assert.equal(res.status, 401);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "ui_token_mismatch");
  });
});

test("GET /ui/hub missing token → 400 bad_request", async () => {
  await withHubDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub`);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "bad_request");
  });
});

async function readOneSseEvent(res: Response): Promise<unknown> {
  // Read body chunks until we hit a `\n\n` separator, then return the
  // parsed JSON from the first `data: …` line.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const idx = buf.indexOf("\n\n");
    if (idx === -1) continue;
    const frame = buf.slice(0, idx);
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine === undefined) {
      // Skip non-data frames (e.g. keepalive `: ping`); keep reading.
      buf = buf.slice(idx + 2);
      continue;
    }
    await reader.cancel();
    return JSON.parse(dataLine.slice("data: ".length));
  }
  throw new Error("SSE stream ended before a data frame arrived");
}

test("GET /ui/hub/stream with valid token delivers a navigate event after surface()", async () => {
  await withHubDaemon(async (ctx) => {
    // Start the SSE request first so attach() fires before surface().
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/stream?token=${encodeURIComponent(ctx.broker.hubToken())}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(res.headers.get("cache-control"), "no-store");

    // Give the route handler a microtask to wire up attach().
    await new Promise((r) => setTimeout(r, 30));

    ctx.broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);

    const event = await readOneSseEvent(res);
    assert.deepEqual(
      { type: (event as { type: string }).type, seq: (event as { seq: number }).seq },
      { type: "navigate", seq: 1 },
    );
    assert.match(
      (event as { url: string }).url,
      /id=a.*hub_seq=1|hub_seq=1.*id=a/,
    );
  });
});

test("GET /ui/hub/stream with wrong token → 401 ui_token_mismatch", async () => {
  await withHubDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/stream?token=WRONG`);
    assert.equal(res.status, 401);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, "ui_token_mismatch");
  });
});

test("Second SSE connection displaces the first", async () => {
  await withHubDaemon(async (ctx) => {
    // First connection.
    const r1 = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/stream?token=${encodeURIComponent(ctx.broker.hubToken())}`);
    await new Promise((res) => setTimeout(res, 30));
    // Second connection — should displace r1.
    const r2 = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/stream?token=${encodeURIComponent(ctx.broker.hubToken())}`);
    await new Promise((res) => setTimeout(res, 30));

    const displaced = await readOneSseEvent(r1);
    assert.equal((displaced as { type: string }).type, "displaced");

    // r2 should be alive and ready for events.
    ctx.broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t", 5555);
    const navigate = await readOneSseEvent(r2);
    assert.equal((navigate as { type: string }).type, "navigate");
  });
});

test("POST /ui/hub/done with valid token + matching seq → 200 ok:true; broker advances", async () => {
  await withHubDaemon(async (ctx) => {
    const fakeSub: import("./hub-broker.js").HubSubscriber = {
      write: () => undefined,
      close: () => undefined,
    };
    ctx.broker.attach(fakeSub);
    ctx.broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
    assert.equal(ctx.broker.peekState().activeSeq, 1);

    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 1 }),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { ok: boolean };
    assert.equal(body.ok, true);
    assert.equal(ctx.broker.peekState().activeUrl, null);
  });
});

test("POST /ui/hub/done with wrong token → 401 ui_token_mismatch", async () => {
  await withHubDaemon(async (ctx) => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=WRONG`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 1 }),
    });
    assert.equal(r.status, 401);
  });
});

test("POST /ui/hub/done mismatched seq → 200 (idempotent no-op)", async () => {
  await withHubDaemon(async (ctx) => {
    const fakeSub: import("./hub-broker.js").HubSubscriber = {
      write: () => undefined,
      close: () => undefined,
    };
    ctx.broker.attach(fakeSub);
    ctx.broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 999 }),
    });
    assert.equal(r.status, 200);
    // Still active — mismatched seq did NOT advance.
    assert.equal(ctx.broker.peekState().activeUrl, "http://127.0.0.1:5555/ui/approve?id=a&token=t");
  });
});

test("POST /ui/hub/done malformed JSON → 400 bad_request", async () => {
  await withHubDaemon(async (ctx) => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "bad_request");
  });
});

test("POST /ui/hub/done {seq:'abc'} → 400 bad_request", async () => {
  await withHubDaemon(async (ctx) => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: "abc" }),
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "bad_request");
  });
});

test("POST /ui/hub/done {seq:-1} → 400 bad_request", async () => {
  await withHubDaemon(async (ctx) => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: -1 }),
    });
    assert.equal(r.status, 400);
  });
});

test("POST /ui/hub/done missing body → 400", async () => {
  await withHubDaemon(async (ctx) => {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
    });
    assert.equal(r.status, 400);
  });
});

test("POST /ui/hub/done body > 1024 bytes → request_too_large", async () => {
  await withHubDaemon(async (ctx) => {
    const oversized = JSON.stringify({ seq: 1, padding: "x".repeat(2000) });
    const r = await fetch(`http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    assert.notEqual(r.status, 200);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "request_too_large");
  });
});
