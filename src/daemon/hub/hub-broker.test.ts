import assert from "node:assert/strict";
import test from "node:test";
import {
  HubBroker,
  SPAWN_TIMEOUT_MS,
  type HubEvent,
  type HubSubscriber,
  withHubSeq,
} from "./hub-broker.js";

function makeSubscriber(): { sub: HubSubscriber; events: HubEvent[]; closed: () => boolean } {
  const events: HubEvent[] = [];
  let isClosed = false;
  return {
    sub: {
      write: (e) => events.push(e),
      close: () => { isClosed = true; },
    },
    events,
    closed: () => isClosed,
  };
}

function newBroker(opts: { now?: () => number; openUrl?: (u: string) => void } = {}): {
  broker: HubBroker;
  opens: string[];
} {
  const opens: string[] = [];
  const broker = new HubBroker({
    // Test default: capture spawn calls in an array. Production
    // HubBroker requires an explicit openUrlImpl (see DaemonServices
    // in Task B4 where it passes the real openUrl).
    openUrlImpl: opts.openUrl ?? ((u: string) => opens.push(u)),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { broker, opens };
}

test("withHubSeq appends hub_seq, preserves other params", () => {
  const out = withHubSeq("http://127.0.0.1:5555/ui/approve?id=abc&token=xyz", 7);
  const u = new URL(out);
  assert.equal(u.searchParams.get("hub_seq"), "7");
  assert.equal(u.searchParams.get("id"), "abc");
  assert.equal(u.searchParams.get("token"), "xyz");
});

test("withHubSeq replaces existing hub_seq", () => {
  const out = withHubSeq("http://127.0.0.1:5555/ui/approve?id=abc&hub_seq=1", 9);
  assert.equal(new URL(out).searchParams.get("hub_seq"), "9");
});

test("hubUrl(port) returns absolute URL with hubToken", () => {
  const { broker } = newBroker();
  const url = new URL(broker.hubUrl(8765));
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "8765");
  assert.equal(url.pathname, "/ui/hub");
  assert.equal(url.searchParams.get("token"), broker.hubToken());
});

test("tokenMatches is true for the broker's token and false otherwise", () => {
  const { broker } = newBroker();
  assert.equal(broker.tokenMatches(broker.hubToken()), true);
  assert.equal(broker.tokenMatches("not-the-token"), false);
  assert.equal(broker.tokenMatches(""), false);
});

test("tokenMatches rejects same-length wrong tokens (timing-safe path is exercised)", () => {
  const { broker } = newBroker();
  const sameLengthWrong = "x".repeat(broker.hubToken().length);
  assert.equal(broker.tokenMatches(sameLengthWrong), false);
});

test("surface attached+idle → writes navigate, sets active", () => {
  const { broker, opens } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
  assert.equal(events.length, 1);
  const ev = events[0] as Extract<HubEvent, { type: "navigate" }>;
  assert.equal(ev.type, "navigate");
  assert.equal(ev.seq, 1);
  assert.equal(new URL(ev.url).searchParams.get("hub_seq"), "1");
  assert.equal(opens.length, 0); // attached, no spawn
});

test("surface attached+busy → enqueue only, no write", () => {
  const { broker } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t2", 5555);
  assert.equal(events.length, 1); // only the first navigate
});

test("surface detached + no spawn → spawn once, no event yet", () => {
  const { broker, opens } = newBroker();
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
  assert.equal(opens.length, 1);
  assert.equal(opens[0], broker.hubUrl(5555));
});

test("surface detached + within timeout → no respawn", () => {
  let t = 1_000_000;
  const { broker, opens } = newBroker({ now: () => t });
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  t += 100;
  broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t2", 5555);
  assert.equal(opens.length, 1);
});

test("surface detached + past timeout → respawn", () => {
  let t = 1_000_000;
  const { broker, opens } = newBroker({ now: () => t });
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  t += SPAWN_TIMEOUT_MS + 1;
  broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t2", 5555);
  assert.equal(opens.length, 2);
});

test("attach + detach lifecycle: detach callback nulls currentSubscriber", () => {
  const { broker } = newBroker();
  const { sub } = makeSubscriber();
  const detach = broker.attach(sub);
  assert.equal(broker.peekState().isAttached, true);
  detach();
  assert.equal(broker.peekState().isAttached, false);
});

test("surface detached + activeUrl set after detach → enqueue + respawn", () => {
  const { broker, opens } = newBroker();
  const { sub } = makeSubscriber();
  const detach = broker.attach(sub);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  // activeUrl is now set; subscriber attached, but no spawn yet.
  assert.equal(opens.length, 0);
  detach(); // SSE close
  // Now surface again while detached. activeUrl is still set; queue grows.
  broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t2", 5555);
  // !isSpawnInFlight (attach cleared it). Should respawn.
  assert.equal(opens.length, 1);
  assert.equal(broker.peekState().activeUrl, "http://127.0.0.1:5555/ui/approve?id=a&token=t1");
  assert.equal(broker.peekState().queueLength, 1);
});

test("attach empty broker → no resend, no event", () => {
  const { broker } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  assert.equal(events.length, 0);
});

test("attach with active set → resend navigate(active, activeSeq)", () => {
  const { broker } = newBroker();
  const { sub: sub1 } = makeSubscriber();
  const detach1 = broker.attach(sub1);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
  // sub1 saw navigate(a, seq=1). Detach.
  detach1();
  // New attach → resend.
  const { sub: sub2, events: events2 } = makeSubscriber();
  broker.attach(sub2);
  assert.equal(events2.length, 1);
  const ev = events2[0] as Extract<HubEvent, { type: "navigate" }>;
  assert.equal(ev.type, "navigate");
  assert.equal(ev.seq, 1);
});

test("attach displaces prior: prior gets {displaced} + close()", () => {
  const { broker } = newBroker();
  const a = makeSubscriber();
  const b = makeSubscriber();
  broker.attach(a.sub);
  broker.attach(b.sub);
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0]?.type, "displaced");
  assert.equal(a.closed(), true);
});

test("attach drains queue front when no active", () => {
  const { broker } = newBroker();
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t2", 5555);
  // queue grows while detached; activeUrl still null.
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  // Promotes front → navigate(a, seq=1). queue has [b] left.
  assert.equal(events.length, 1);
  const ev = events[0] as Extract<HubEvent, { type: "navigate" }>;
  assert.equal(ev.seq, 1);
  assert.equal(broker.peekState().queueLength, 1);
});

test("attach clears spawnInFlightSince", () => {
  let t = 1_000_000;
  const { broker, opens } = newBroker({ now: () => t });
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
  assert.equal(opens.length, 1);
  const { sub } = makeSubscriber();
  broker.attach(sub);
  assert.equal(broker.peekState().spawnInFlight, false);
  t += 100;
  // Detach then surface within the would-be-debounce window.
  // After attach the flag is cleared, so a new surface (after a re-detach) respawns.
});

test("markDone matching → clear + promote next", () => {
  const { broker } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t2", 5555);
  // events: [navigate(a,1)]; queue=[b]
  assert.equal(events.length, 1);
  broker.markDone(1);
  // promotes b → navigate(b,2)
  assert.equal(events.length, 2);
  const ev = events[1] as Extract<HubEvent, { type: "navigate" }>;
  assert.equal(ev.seq, 2);
});

test("markDone mismatched seq → no-op", () => {
  const { broker } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  // active is seq=1
  broker.markDone(99);
  // still active, no further events
  assert.equal(events.length, 1);
  assert.equal(broker.peekState().activeUrl, "http://127.0.0.1:5555/ui/approve?id=a&token=t1");
});

test("markDone with empty queue → clear active only, no further writes", () => {
  const { broker } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
  broker.markDone(1);
  assert.equal(events.length, 1); // only the original navigate
  assert.equal(broker.peekState().activeUrl, null);
  assert.equal(broker.peekState().queueLength, 0);
});

test("FIFO ordering across interleavings", () => {
  const { broker } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t", 5555);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=b&token=t", 5555);
  broker.surface("http://127.0.0.1:5555/ui/approve?id=c&token=t", 5555);
  broker.markDone(1);
  broker.markDone(2);
  broker.markDone(3);
  const ids = events
    .filter((e) => e.type === "navigate")
    .map((e) => new URL((e as Extract<HubEvent, { type: "navigate" }>).url).searchParams.get("id"));
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("emitBootstrapCaptureStep: attached → writes event on SSE", () => {
  const { broker } = newBroker();
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  broker.emitBootstrapCaptureStep(
    {
      batch_id: "b1",
      secret_name: "STRIPE_KEY",
      url: "https://dashboard.stripe.com/login",
      step_idx: 1,
      step_total: 3,
      capture_token: "tok-xyz",
    },
    5555,
  );
  const cap = events.find((e) => e.type === "bootstrap_capture_step");
  assert.ok(cap, "bootstrap_capture_step must be written when attached");
  assert.equal((cap as { capture_token: string }).capture_token, "tok-xyz");
});

test("emitBootstrapCaptureStep: detached → spawns hub via openUrlImpl", () => {
  // Pre-fix: when no hub was attached, the event was silently dropped via
  // optional chaining (this.currentSubscriber?.write). The executor would
  // then deadlock awaiting the registry timeout (5 minutes) with no UI.
  // Now: detached emit MUST spawn the hub tab so the user sees the card.
  const { broker, opens } = newBroker();
  broker.emitBootstrapCaptureStep(
    {
      batch_id: "b1",
      secret_name: "STRIPE_KEY",
      url: "https://dashboard.stripe.com/login",
      step_idx: 1,
      step_total: 3,
      capture_token: "tok-xyz",
    },
    7777,
  );
  assert.equal(opens.length, 1, "openUrlImpl must be called when detached");
  const u = new URL(opens[0]!);
  assert.equal(u.port, "7777");
  assert.equal(u.pathname, "/ui/hub");
  // Capture is stashed so a later attach can replay it.
  assert.ok(broker.lastBootstrapCaptureStep);
});

test("attach: replays pending bootstrap_capture_step from earlier detached emit", () => {
  // Companion to the spawn-on-emit fix: once the user-agent attaches, the
  // hub must replay the latest pending capture step so the coordinator card
  // surfaces. Without this, the spawn opens an empty hub.
  const { broker } = newBroker();
  broker.emitBootstrapCaptureStep(
    {
      batch_id: "b1",
      secret_name: "STRIPE_KEY",
      url: "https://dashboard.stripe.com/login",
      step_idx: 2,
      step_total: 3,
      capture_token: "tok-replay",
    },
    5555,
  );
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  const cap = events.find((e) => e.type === "bootstrap_capture_step");
  assert.ok(cap, "attach must replay the pending capture step");
  assert.equal((cap as { capture_token: string }).capture_token, "tok-replay");
  assert.equal((cap as { step_idx: number }).step_idx, 2);
});

test("emitBootstrapCaptureStep: detached + already spawning → no duplicate spawn", () => {
  // The same debounce as surface(): if spawn is in flight, a second emit
  // must not stack another openUrlImpl call.
  const { broker, opens } = newBroker();
  broker.emitBootstrapCaptureStep(
    {
      batch_id: "b1", secret_name: "K", url: "https://x", step_idx: 1, step_total: 1, capture_token: "t1",
    },
    5555,
  );
  broker.emitBootstrapCaptureStep(
    {
      batch_id: "b1", secret_name: "K", url: "https://x", step_idx: 1, step_total: 1, capture_token: "t2",
    },
    5555,
  );
  assert.equal(opens.length, 1, "spawn-in-flight must debounce a second emit");
});

test("clearBootstrapCaptureStep(matching token): drops pending so subsequent attach does NOT replay", () => {
  // After the executor settles a capture await (any of the five branches),
  // it MUST clear the pending event. A fresh hub attach after that point
  // must NOT receive a stale bootstrap_capture_step (otherwise the UI's
  // capture-mode iframe-hide would mask any unrelated navigate replay).
  const { broker } = newBroker();
  broker.emitBootstrapCaptureStep(
    {
      batch_id: "b1",
      secret_name: "STRIPE_KEY",
      url: "https://x",
      step_idx: 1,
      step_total: 1,
      capture_token: "tok-A",
    },
    5555,
  );

  broker.clearBootstrapCaptureStep("tok-A");

  // Verify the clear took effect by attaching a fresh subscriber and
  // checking that NO bootstrap_capture_step event is replayed.
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  const cap = events.find((e) => e.type === "bootstrap_capture_step");
  assert.equal(
    cap,
    undefined,
    "after clear, attach must NOT replay the cleared capture step",
  );
});

test("clearBootstrapCaptureStep(mismatched token): no-op — pending stays, attach still replays", () => {
  // Token guard rationale: if a rapid-fire next capture has already
  // replaced pendingCaptureStep with a NEW event, an old executor's
  // finally clear (carrying the previous capture_token) must NOT wipe
  // the new pending event. Each capture's own finally is the one that
  // authoritatively drops its slot — by token equality.
  const { broker } = newBroker();
  broker.emitBootstrapCaptureStep(
    {
      batch_id: "b1",
      secret_name: "K",
      url: "https://x",
      step_idx: 1,
      step_total: 1,
      capture_token: "tok-NEW",
    },
    5555,
  );

  // Try to clear with a STALE token (e.g., a previous capture's settle
  // arriving after a newer emit has overwritten the slot).
  broker.clearBootstrapCaptureStep("tok-STALE");

  // pendingCaptureStep is private; verify via attach replay.
  const { sub, events } = makeSubscriber();
  broker.attach(sub);
  const cap = events.find((e) => e.type === "bootstrap_capture_step");
  assert.ok(
    cap,
    "mismatched-token clear must be a no-op — newer pending event must still replay",
  );
  assert.equal(
    (cap as { capture_token: string }).capture_token,
    "tok-NEW",
    "newer event survives stale clear",
  );
});

test("clearBootstrapCaptureStep: clear before emit (defensive) → no-op, no throw", () => {
  // Defensive: clear may legitimately race ahead of an emit (e.g., a test
  // calls it on a fresh broker) — must not throw.
  const { broker } = newBroker();
  broker.clearBootstrapCaptureStep("any-token");
  // lastBootstrapCaptureStep should still be null — clear must not
  // accidentally allocate state.
  assert.equal(broker.lastBootstrapCaptureStep, null);
});
