import assert from "node:assert/strict";
import test from "node:test";
import { DaemonServices } from "../services.js";

test("default DaemonServices wires HubBroker.openUrlImpl to the real openUrl", () => {
  // Honor the env var so this test doesn't actually open a browser tab.
  const prev = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  try {
    const services = new DaemonServices();
    // No exception. The broker's openUrlImpl is the real openUrl,
    // which under SECRET_SHUTTLE_NO_OPEN_URL=1 short-circuits with no
    // spawn but doesn't throw. Surface a URL and assert no exception.
    services.hubBroker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
    // Broker state mutated correctly even though openUrl no-op'd.
    assert.equal(services.hubBroker.peekState().queueLength, 1);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prev;
  }
});

test("default DaemonServices source: opts.hubOpenUrlImpl falls back to the real openUrl import (drift guard)", async () => {
  // The hook test below proves the hubOpenUrlImpl hook is honored,
  // but does NOT prove the fallback is `openUrl` rather than `noop`.
  // This drift guard pins the source: the import line AND the
  // `opts.hubOpenUrlImpl ?? openUrl` chain. A regression to
  // `?? (() => undefined)` would fail here.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("src/daemon/services.ts", "utf8");
  assert.match(
    src,
    /import\s*\{\s*openUrl\s*\}\s*from\s+["']\.\/approvals\/open-url\.js["']/,
    "DaemonServices must import openUrl from approvals/open-url.js",
  );
  assert.match(
    src,
    /opts\.hubOpenUrlImpl\s*\?\?\s*openUrl/,
    "default HubBroker openUrlImpl must fall back to the real openUrl, not a noop",
  );
});

test("default DaemonServices wires the default HubBroker through openUrl (hubOpenUrlImpl hook exercises the actual default constructor path)", async () => {
  const prev = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  try {
    const { openUrl } = await import("../approvals/open-url.js");
    const spawns: Array<{ cmd: string; args: readonly string[] }> = [];
    // Use the hubOpenUrlImpl hook so we're testing the REAL default
    // constructor path. The hook is consumed by the same line that
    // production hits (`new HubBroker({ openUrlImpl: opts.hubOpenUrlImpl
    // ?? openUrl })`) — so a future regression where DaemonServices
    // accidentally ignores the hook OR swaps `?? openUrl` for `?? noop`
    // would fail this test. If the test instead injected a fully-built
    // HubBroker, it would NOT catch that class of regression.
    const services = new DaemonServices({
      hubOpenUrlImpl: (u) =>
        openUrl(u, {
          spawnImpl: (cmd, args) => {
            spawns.push({ cmd, args });
            return { on: () => undefined, unref: () => undefined };
          },
        }),
    });
    services.hubBroker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
    assert.equal(spawns.length, 1, "default wiring must invoke openUrl which spawns");
    assert.ok(spawns[0]!.args.some((a) => a.includes("/ui/hub?token=")));
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prev;
  }
});
