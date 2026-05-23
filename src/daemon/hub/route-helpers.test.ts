import assert from "node:assert/strict";
import test from "node:test";
import { DaemonServices } from "../services.js";
import { HubBroker } from "./hub-broker.js";
import { makeHubOpenUrlImpl } from "./route-helpers.js";

test("makeHubOpenUrlImpl returns a function that calls services.hubBroker.surface with the resolved port", () => {
  const opens: string[] = [];
  const broker = new HubBroker({ openUrlImpl: (u) => opens.push(u) });
  const services = new DaemonServices({ hubBroker: broker });
  let port = 7777;
  const helper = makeHubOpenUrlImpl(services, () => port);
  helper("http://127.0.0.1:7777/ui/approve?id=abc&token=xyz");
  // Broker spawned the hub on first surface; verify it used port 7777.
  assert.equal(opens.length, 1);
  assert.match(opens[0]!, /^http:\/\/127\.0\.0\.1:7777\/ui\/hub\?token=/);
});

test("makeHubOpenUrlImpl re-reads the port on every invocation (not baked in at construction)", () => {
  // Mock the broker directly so we can observe `port` arg per call,
  // without depending on broker spawn-debounce semantics.
  const calls: Array<{ url: string; port: number }> = [];
  const mockBroker = {
    surface: (url: string, port: number) => { calls.push({ url, port }); },
  };
  const services = { hubBroker: mockBroker } as unknown as DaemonServices;
  let port = 1111;
  const helper = makeHubOpenUrlImpl(services, () => port);
  helper("http://127.0.0.1/foo");
  port = 2222;
  helper("http://127.0.0.1/bar");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.port, 1111, "first call must use the port at-time-of-call");
  assert.equal(calls[1]?.port, 2222, "second call must re-read the port (regression: baked-in closure)");
});
