import assert from "node:assert/strict";
import test from "node:test";
import { HubBroker, type HubSubscriber } from "./hub-broker.js";
import { openUrl } from "../approvals/open-url.js";

test("HubBroker calling openUrl honors SECRET_SHUTTLE_NO_OPEN_URL=1 (no spawn)", () => {
  const prev = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  try {
    const spawns: Array<{ cmd: string; args: readonly string[] }> = [];
    const broker = new HubBroker({
      // The real openUrl checks the env var and no-ops; pass a wrapper
      // that delegates to real openUrl with a spy spawn so we can prove
      // no spawn occurred.
      openUrlImpl: (u: string) => {
        openUrl(u, {
          spawnImpl: (cmd, args, _opts) => {
            spawns.push({ cmd, args });
            return { on: () => undefined, unref: () => undefined };
          },
        });
      },
    });
    broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
    assert.equal(spawns.length, 0, "SECRET_SHUTTLE_NO_OPEN_URL must suppress spawn");
    // State machine still mutates correctly.
    assert.equal(broker.peekState().queueLength, 1);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prev;
  }
});

test("HubBroker state machine proceeds normally with attach() under SECRET_SHUTTLE_NO_OPEN_URL=1", () => {
  const prev = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  try {
    const broker = new HubBroker({ openUrlImpl: (u: string) => openUrl(u) });
    broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
    const events: import("./hub-broker.js").HubEvent[] = [];
    const sub: HubSubscriber = { write: (e) => events.push(e), close: () => undefined };
    broker.attach(sub);
    // Even though no real browser opened, attach drains the queue front.
    assert.equal(events.length, 1);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prev;
  }
});
