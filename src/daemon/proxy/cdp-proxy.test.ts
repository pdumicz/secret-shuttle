import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import type { CdpClient } from "../chrome/cdp-client.js";
import type { CdpMessage } from "../chrome/pipe-transport.js";
import { DaemonBlindModeState } from "../services-blind.js";
import { startCdpProxy } from "./cdp-proxy.js";

// Minimal transport stub: EventEmitter with a send() that records sent messages.
// The proxy registers via opts.transport.on("message", handler) and calls
// opts.transport.removeListener("message", handler) on close.
class FakeTransport extends EventEmitter {
  sent: CdpMessage[] = [];
  send(msg: CdpMessage): void {
    this.sent.push(msg);
  }
}

// ── Existing tests (preserved) ────────────────────────────────────────────────

test("proxy drops ALL Chrome→agent events during blind mode (total blackout)", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const fakeCdp = {} as unknown as CdpClient;

  const proxy = await startCdpProxy({
    transport: transport as never,
    cdp: fakeCdp,
    blind,
  });

  try {
    const messages: CdpMessage[] = [];
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((res) => ws.on("open", () => res()));
    ws.on("message", (data: Buffer) => {
      messages.push(JSON.parse(data.toString("utf8")) as CdpMessage);
    });

    blind.start("dashboard.stripe.com", "test");

    transport.emit("message", { method: "Page.frameNavigated", params: { url: "https://x" } });
    transport.emit("message", { method: "Network.responseReceived", params: { secret: "leak" } });
    transport.emit("message", { method: "Runtime.consoleAPICalled", params: { args: ["leak"] } });

    await new Promise((r) => setTimeout(r, 50));

    const methods = messages.map((m) => m.method);
    assert.equal(methods.includes("Page.frameNavigated"), false, "Page.frameNavigated must be dropped during blind mode");
    assert.equal(methods.includes("Network.responseReceived"), false, "Network.responseReceived should be dropped");
    assert.equal(methods.includes("Runtime.consoleAPICalled"), false, "Runtime.consoleAPICalled should be dropped");
    assert.equal(messages.length, 0, "no events should cross the proxy during blind mode");

    ws.close();
  } finally {
    await proxy.close();
  }
});

test("proxy forwards all Chrome→agent events when blind mode is off", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const fakeCdp = {} as unknown as CdpClient;

  const proxy = await startCdpProxy({
    transport: transport as never,
    cdp: fakeCdp,
    blind,
  });

  try {
    const messages: CdpMessage[] = [];
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((res) => ws.on("open", () => res()));
    ws.on("message", (data: Buffer) => {
      messages.push(JSON.parse(data.toString("utf8")) as CdpMessage);
    });

    transport.emit("message", { method: "Network.responseReceived", params: { ok: true } });
    transport.emit("message", { method: "Runtime.consoleAPICalled", params: { ok: true } });

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(messages.some((m) => m.method === "Network.responseReceived"), "should forward when blind off");
    assert.ok(messages.some((m) => m.method === "Runtime.consoleAPICalled"), "should forward when blind off");

    ws.close();
  } finally {
    await proxy.close();
  }
});

test("proxy drops Page.screencastFrame in blind mode", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const fakeCdp = {} as unknown as CdpClient;

  const proxy = await startCdpProxy({
    transport: transport as never,
    cdp: fakeCdp,
    blind,
  });

  try {
    const messages: CdpMessage[] = [];
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((res) => ws.on("open", () => res()));
    ws.on("message", (data: Buffer) => {
      messages.push(JSON.parse(data.toString("utf8")) as CdpMessage);
    });

    blind.start("example.com", "screencast test");

    transport.emit("message", { method: "Page.screencastFrame", params: { data: "base64encoded" } });

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(messages.some((m) => m.method === "Page.screencastFrame"), false, "screencastFrame should be dropped");

    ws.close();
  } finally {
    await proxy.close();
  }
});

test("blind mode drops Chrome→agent RESPONSES, not just events (pre-armed Runtime.evaluate leak)", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    const received: CdpMessage[] = [];
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((res) => ws.on("open", () => res()));
    ws.on("message", (d: Buffer) => received.push(JSON.parse(d.toString("utf8")) as CdpMessage));

    // Agent issues a request BEFORE blind mode (id 99).
    ws.send(JSON.stringify({ id: 99, method: "Runtime.evaluate", params: { expression: "x" } }));
    await new Promise((r) => setTimeout(r, 30));
    const proxyId = (transport.sent.at(-1) as CdpMessage).id as number;

    // Blind mode starts.
    blind.start("dashboard.stripe.com", "secret window");

    // Chrome now delivers the RESPONSE while blind is active.
    transport.emit("message", { id: proxyId, result: { value: "SECRET_FROM_PENDING_RUNTIME_EVALUATE" } });
    transport.emit("message", { method: "Network.responseReceived", params: { x: 1 } });

    await new Promise((r) => setTimeout(r, 50));

    const blob = JSON.stringify(received);
    assert.equal(blob.includes("SECRET_FROM_PENDING_RUNTIME_EVALUATE"), false);
    assert.equal(received.some((m) => m.id === 99), false);
    assert.equal(received.some((m) => m.method === "Network.responseReceived"), false);

    ws.close();
  } finally {
    await proxy.close();
  }
});

test("severAgentConnections closes connected agent sockets", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((res) => ws.on("open", () => res()));
    const closed = new Promise<void>((res) => ws.on("close", () => res()));
    proxy.severAgentConnections();
    await closed; // must resolve — the socket was force-closed by the proxy
    assert.equal(ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED, true);
  } finally {
    await proxy.close();
  }
});

test("after blind ends, a fresh agent connection works again", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    blind.start("x.com", "r");
    proxy.severAgentConnections();
    blind.end();

    const ws = new WebSocket(proxy.url);
    await new Promise<void>((res) => ws.on("open", () => res()));
    const received: CdpMessage[] = [];
    ws.on("message", (d: Buffer) => received.push(JSON.parse(d.toString("utf8")) as CdpMessage));
    transport.emit("message", { method: "Page.frameNavigated", params: { ok: true } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.some((m) => m.method === "Page.frameNavigated"), true);
    ws.close();
  } finally {
    await proxy.close();
  }
});

// ── New tests (id-rewriting, ownership, epoch barrier) ────────────────────────

test("normal request/response is id-rewritten transparently end to end", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as unknown as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((r) => ws.on("open", () => r()));
    const got: CdpMessage[] = [];
    ws.on("message", (d: Buffer) => got.push(JSON.parse(d.toString("utf8")) as CdpMessage));

    // Agent sends id 7.
    ws.send(JSON.stringify({ id: 7, method: "Browser.getVersion" }));
    await new Promise((r) => setTimeout(r, 30));

    // Transport saw a rewritten (high) id, not 7.
    const forwarded = transport.sent.at(-1) as CdpMessage;
    assert.notEqual(forwarded.id, 7);
    assert.ok((forwarded.id as number) >= 1_000_000_000, "proxy id must be >= 1_000_000_000");

    // Chrome replies with the rewritten id; agent must see ORIGINAL id 7.
    transport.emit("message", { id: forwarded.id, result: { product: "X" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.some((m) => m.id === 7), true, "agent must see original id 7");
  } finally {
    await proxy.close();
  }
});

test("late response to a PRE-BLIND request never reaches a reconnected socket", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as unknown as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    // Socket A sends id 99 BEFORE blind.
    const a = new WebSocket(proxy.url);
    await new Promise<void>((r) => a.on("open", () => r()));
    a.send(JSON.stringify({ id: 99, method: "Runtime.evaluate", params: { expression: "later" } }));
    await new Promise((r) => setTimeout(r, 30));
    const proxyId = (transport.sent.at(-1) as CdpMessage).id as number;

    // Blind starts → sever A + bump epoch (simulate what the route does).
    blind.start("dashboard.stripe.com", "secret");
    proxy.severAgentConnections();
    blind.end();

    // Socket B connects post-blind.
    const b = new WebSocket(proxy.url);
    await new Promise<void>((r) => b.on("open", () => r()));
    const got: CdpMessage[] = [];
    b.on("message", (d: Buffer) => got.push(JSON.parse(d.toString("utf8")) as CdpMessage));

    // Chrome finally delivers the old response.
    transport.emit("message", { id: proxyId, result: { value: "SECRET_FROM_OLD_PENDING_REQUEST" } });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(JSON.stringify(got).includes("SECRET_FROM_OLD_PENDING_REQUEST"), false, "cross-epoch response must not reach any socket");
    assert.equal(got.some((m) => m.id === 99), false, "original id 99 must not appear on socket B");
    a.close();
    b.close();
  } finally {
    await proxy.close();
  }
});

test("daemon-internal CdpClient ids (low, not proxy-allocated) are never forwarded to the agent", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as unknown as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((r) => ws.on("open", () => r()));
    const got: CdpMessage[] = [];
    ws.on("message", (d: Buffer) => got.push(JSON.parse(d.toString("utf8")) as CdpMessage));

    // Daemon-internal response (id 3, never allocated by the proxy).
    transport.emit("message", { id: 3, result: { value: "DAEMON_INTERNAL_SECRET_READ" } });
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(JSON.stringify(got).includes("DAEMON_INTERNAL_SECRET_READ"), false, "daemon-internal response must never reach agent");
    ws.close();
  } finally {
    await proxy.close();
  }
});

test("events still broadcast to the agent when blind is off, dropped when blind on", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as unknown as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((r) => ws.on("open", () => r()));
    const got: CdpMessage[] = [];
    ws.on("message", (d: Buffer) => got.push(JSON.parse(d.toString("utf8")) as CdpMessage));

    // Event when blind is off — must reach agent.
    transport.emit("message", { method: "Page.frameNavigated", params: { ok: true } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.some((m) => m.method === "Page.frameNavigated"), true, "event must arrive when blind off");

    // Blind on — second event must be dropped.
    blind.start("x.com", "r");
    transport.emit("message", { method: "Page.frameNavigated", params: { ok: 2 } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(got.filter((m) => m.method === "Page.frameNavigated").length, 1, "only the first event must have arrived");

    ws.close();
  } finally {
    await proxy.close();
  }
});

test("response is routed only to the owning socket, not broadcast to all sockets", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as unknown as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    const a = new WebSocket(proxy.url);
    await new Promise<void>((r) => a.on("open", () => r()));
    const gotA: CdpMessage[] = [];
    a.on("message", (d: Buffer) => gotA.push(JSON.parse(d.toString("utf8")) as CdpMessage));

    const b = new WebSocket(proxy.url);
    await new Promise<void>((r) => b.on("open", () => r()));
    const gotB: CdpMessage[] = [];
    b.on("message", (d: Buffer) => gotB.push(JSON.parse(d.toString("utf8")) as CdpMessage));

    // Socket A sends a command.
    a.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await new Promise((r) => setTimeout(r, 30));
    const proxyId = (transport.sent.at(-1) as CdpMessage).id as number;

    // Chrome responds.
    transport.emit("message", { id: proxyId, result: { product: "Chrome" } });
    await new Promise((r) => setTimeout(r, 30));

    // Only socket A should have received it.
    assert.equal(gotA.some((m) => m.id === 1), true, "owning socket A must receive the response");
    assert.equal(gotB.some((m) => m.id === 1), false, "non-owning socket B must NOT receive the response");

    a.close();
    b.close();
  } finally {
    await proxy.close();
  }
});

test("pending entries for a closed socket are cleaned up (no unbounded growth)", async () => {
  const transport = new FakeTransport();
  const blind = new DaemonBlindModeState();
  const proxy = await startCdpProxy({
    transport: transport as unknown as never,
    cdp: {} as unknown as CdpClient,
    blind,
  });
  try {
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((r) => ws.on("open", () => r()));

    // Send a request and record the proxy id.
    ws.send(JSON.stringify({ id: 42, method: "Runtime.evaluate", params: { expression: "1" } }));
    await new Promise((r) => setTimeout(r, 30));
    const proxyId = (transport.sent.at(-1) as CdpMessage).id as number;

    // Close the socket before Chrome responds.
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 30));

    // Chrome now delivers the response — it should be silently dropped (no throw, no crash).
    assert.doesNotThrow(() => {
      transport.emit("message", { id: proxyId, result: { value: "late" } });
    });

    // Open a new socket and verify it receives nothing.
    const ws2 = new WebSocket(proxy.url);
    await new Promise<void>((r) => ws2.on("open", () => r()));
    const got: CdpMessage[] = [];
    ws2.on("message", (d: Buffer) => got.push(JSON.parse(d.toString("utf8")) as CdpMessage));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(got.length, 0, "no stale response must leak to a new socket");
    ws2.close();
  } finally {
    await proxy.close();
  }
});
