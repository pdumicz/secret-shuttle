import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import type { CdpClient } from "../chrome/cdp-client.js";
import type { CdpMessage } from "../chrome/pipe-transport.js";
import { DaemonBlindModeState } from "../services-blind.js";
import { startCdpProxy } from "./cdp-proxy.js";

// Minimal transport stub: EventEmitter with a no-op send().
// The proxy registers via opts.transport.on("message", handler) and calls
// opts.transport.removeListener("message", handler) on ws close.
class FakeTransport extends EventEmitter {
  sent: CdpMessage[] = [];
  send(msg: CdpMessage): void {
    this.sent.push(msg);
  }
}

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

    // Chrome emits navigation, sensitive events — ALL must be dropped during blind mode.
    transport.emit("message", { method: "Page.frameNavigated", params: { url: "https://x" } });
    transport.emit("message", { method: "Network.responseReceived", params: { secret: "leak" } });
    transport.emit("message", { method: "Runtime.consoleAPICalled", params: { args: ["leak"] } });

    // Give the WebSocket a moment to receive buffered messages.
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

    // Blind mode is NOT active — all events should flow through.
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
