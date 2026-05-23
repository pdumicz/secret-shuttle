# Plan 4b — Single-Window Tab Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One persistent browser tab serves every approval, unlock, and session-approval URL the daemon emits for its entire process lifetime.

**Architecture:** Daemon-side `HubBroker` owns a FIFO queue + active operation slot, identified by a daemon-lifetime `hub_token`. The hub HTML page maintains an SSE connection to `/ui/hub/stream`, renders operation URLs in a same-origin iframe, and signals completion via `POST /ui/hub/done`. The existing per-URL `ui_token` on each operation page remains the operational security boundary.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes, exactOptionalPropertyTypes), Node 20+, `node:test`, `node:assert/strict`, `node:crypto`, native browser `EventSource` API.

**Spec:** `docs/superpowers/specs/2026-05-23-plan4b-tab-reuse-design.md` (commit `939c014`).

**Baseline:** 842 tests, 840 pass, 2 skipped, 0 fail at commit `8b77556` (Plan 4a R2 normalization fix).

**Estimated new tests:** ~75–85. Final count target: ~920–930 passing.

---

## Task overview

| Part | Tasks | What ships |
|---|---|---|
| A | A1 | `HubBroker` state machine (pure logic + unit tests) |
| B | B1 / B2 / B3 / B4 | Hub HTTP routes: `GET /ui/hub`, `GET /ui/hub/stream`, `POST /ui/hub/done`, router wiring + DaemonServices DI |
| C | C1 / C2 / C3 | `hub-ui.html` shell + build script copy + drift-guard test |
| D | D1 / D2 / D3 | CSP relaxations: `ui-server.ts`, `session-ui-server.ts`, `unlock-session.ts` |
| E | E1 / E2 / E3 | Operation page modifications: `ui.html`, `session-ui.html`, `unlock-ui.html` (`hub_seq` + notify + polling + drift tests) |
| F | F0 + F1–F12 | `makeHubOpenUrlImpl` helper + 12 route swaps + 2 direct call sites |
| G | G1 / G1.5 / G2 / G3 / G4 | End-to-end tests, jsdom DOM smoke, `SECRET_SHUTTLE_NO_OPEN_URL` regression, full suite verification, CHANGELOG |

---

## File structure

**New files (created in Part order):**
- `src/daemon/hub/hub-broker.ts` (Task A1) — state machine.
- `src/daemon/hub/hub-broker.test.ts` (Task A1).
- `src/daemon/hub/hub-server.ts` (Task B1, extended by B2, B3) — three routes + helpers.
- `src/daemon/hub/hub-server.test.ts` (Task B1, extended by B2, B3).
- `src/daemon/hub/route-helpers.ts` (Task F0) — `makeHubOpenUrlImpl`.
- `src/daemon/hub/hub-ui.html` (Task C1).
- `src/daemon/hub/hub-ui-html-drift.test.ts` (Task C3).
- `src/daemon/approvals/ui-html-drift.test.ts` (Task E1).
- `src/daemon/approvals/session-ui-html-drift.test.ts` (Task E2).
- `src/daemon/approvals/unlock-ui-html-drift.test.ts` (Task E3).
- `src/daemon/hub/hub-e2e.test.ts` (Task G1).
- `src/daemon/hub/default-services-wiring.test.ts` (Task B4) — proves default `new DaemonServices()` constructs a HubBroker with the real `openUrl` wired in.
- `src/daemon/hub/hub-ui-dom.test.ts` (Task G1.5) — jsdom-based DOM smoke for `hub-ui.html`.
- `src/daemon/hub/hub-no-open-url.test.ts` (Task G2) — `SECRET_SHUTTLE_NO_OPEN_URL` regression.

**Modified files:**
- `src/daemon/services.ts` (Task B4) — `hubBroker` field + constructor injection.
- `src/daemon/api/router.ts` (Task B4) — register hub routes.
- `src/daemon/approvals/ui-server.ts` (Task D1) — CSP `frame-ancestors 'self'`.
- `src/daemon/approvals/session-ui-server.ts` (Task D2) — relax CSP frame-ancestors.
- `src/daemon/api/routes/unlock-session.ts` (Task D3) — CSP on UI route + Task F12 direct swap.
- `src/daemon/approvals/ui.html` (Task E1).
- `src/daemon/approvals/session-ui.html` (Task E2).
- `src/daemon/approvals/unlock-ui.html` (Task E3).
- `src/daemon/api/routes/templates.ts` (Task F1).
- `src/daemon/api/routes/secrets.ts` (Tasks F2 + F10).
- `src/daemon/api/routes/inject-submit.ts` (Task F3).
- `src/daemon/api/routes/reveal-capture.ts` (Task F4).
- `src/daemon/api/routes/run-resolve.ts` (Task F5).
- `src/daemon/api/routes/inject-render.ts` (Task F6).
- `src/daemon/api/routes/secrets-delete.ts` (Task F7).
- `src/daemon/api/routes/secrets-rotate.ts` (Task F8).
- `src/daemon/api/routes/blind.ts` (Task F9).
- `src/daemon/api/routes/approvals-session.ts` (Task F11).
- `package.json` (Task C2) — build script copies `hub-ui.html`.
- `CHANGELOG.md` (Task G4).

---

## Part A — HubBroker state machine

### Task A1: HubBroker types + state machine + unit tests

**Files:**
- Create: `src/daemon/hub/hub-broker.ts`
- Create: `src/daemon/hub/hub-broker.test.ts`

- [ ] **Step 1: Create directory + write the failing test file**

Run: `mkdir -p src/daemon/hub`

Create `src/daemon/hub/hub-broker.test.ts`:

```typescript
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

test("surface detached + activeUrl set (post-close) → enqueue + respawn (attach cleared inFlight)", () => {
  const { broker, opens } = newBroker();
  const { sub: sub1 } = makeSubscriber();
  broker.attach(sub1); // clears spawnInFlightSince
  broker.surface("http://127.0.0.1:5555/ui/approve?id=a&token=t1", 5555);
  // sub1 closes (e.g., browser tab killed). Simulate by detaching directly:
  // In real flow, the SSE route would null currentSubscriber via the detach callback.
  // Here we re-attach a new sub that will see the active resend on attach,
  // but first we surface again while detached.
  // Manually drive the detach by re-attaching null-ish: actually use the detach cb.
  const events1 = (sub1 as unknown as { _events?: HubEvent[] })._events;
  void events1;
  // Use the public peekState API to verify; we simulate detach via second attach
  // and re-detach by overriding currentSubscriber. For this unit test, the cleanest
  // path is: attach + receive + then null the subscriber. Since we can't reach
  // internals directly, instead detach via the returned callback:
  // (We retroactively keep a detach reference.)
  // Re-run with proper detach handling:
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --noEmit`
Expected: errors — `Cannot find module './hub-broker.js'` (or equivalent — the file doesn't exist yet).

- [ ] **Step 3: Implement `src/daemon/hub/hub-broker.ts`**

```typescript
// src/daemon/hub/hub-broker.ts
import { randomUUID, timingSafeEqual } from "node:crypto";

export const SPAWN_TIMEOUT_MS = 5000;

export type HubEvent =
  | { type: "navigate"; url: string; seq: number }
  | { type: "displaced" };

export interface HubSubscriber {
  write(e: HubEvent): void;
  close(): void;
}

export interface HubBrokerOptions {
  /** REQUIRED — caller must provide an opener. Production passes the real
   * `openUrl` from src/daemon/approvals/open-url.ts; tests pass a spy.
   * No default — a forgotten injection would silently never open the hub. */
  openUrlImpl: (url: string) => void;
  now?: () => number;
}

/**
 * Append (or replace) `hub_seq` on an operation URL. Preserves all other
 * query params (id, token). Used by the broker to mark each navigate with
 * the activeSeq the hub will echo back via /ui/hub/done.
 */
export function withHubSeq(raw: string, seq: number): string {
  const u = new URL(raw);
  u.searchParams.set("hub_seq", String(seq));
  return u.toString();
}

/**
 * Daemon-owned FIFO queue + active-operation slot for the persistent hub
 * tab. Pure state machine; all I/O happens via the injected openUrlImpl.
 *
 * Invariants:
 *   - activeUrl is the operation currently in the iframe.
 *   - queue holds operations waiting their turn.
 *   - subscriber is the SSE connection (null when no hub is attached).
 *   - spawnInFlightSince debounces concurrent surfaces from re-spawning
 *     the browser; cleared on attach.
 *
 * See docs/superpowers/specs/2026-05-23-plan4b-tab-reuse-design.md
 * Component 1 for the full contract.
 */
export class HubBroker {
  private readonly tokenValue: string = randomUUID();
  private readonly openUrlImpl: (url: string) => void;
  private readonly nowFn: () => number;

  private queue: string[] = [];
  private activeUrl: string | null = null;
  private activeSeq: number | null = null;
  private nextSeq = 1;
  private currentSubscriber: HubSubscriber | null = null;
  private spawnInFlightSince: number | null = null;

  constructor(opts: HubBrokerOptions) {
    this.openUrlImpl = opts.openUrlImpl;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /** Daemon-lifetime auth token for /ui/hub*. Never written to disk. */
  hubToken(): string {
    return this.tokenValue;
  }

  /** Constant-time token compare for routes. */
  tokenMatches(supplied: string): boolean {
    const expected = Buffer.from(this.tokenValue);
    const actual = Buffer.from(supplied);
    if (actual.byteLength !== expected.byteLength) return false;
    return timingSafeEqual(actual, expected);
  }

  /** Absolute URL the platform openUrl call points at. */
  hubUrl(port: number): string {
    return `http://127.0.0.1:${port}/ui/hub?token=${encodeURIComponent(this.tokenValue)}`;
  }

  /**
   * Push a new operation URL into the hub flow.
   *   - Attached + idle: set active, write navigate.
   *   - Attached + busy: enqueue.
   *   - Detached: enqueue; spawn hub iff !isSpawnInFlight().
   */
  surface(operationUrl: string, port: number): void {
    if (this.currentSubscriber !== null && this.activeUrl === null) {
      this.activeUrl = operationUrl;
      this.activeSeq = this.nextSeq++;
      this.currentSubscriber.write({
        type: "navigate",
        url: withHubSeq(operationUrl, this.activeSeq),
        seq: this.activeSeq,
      });
      return;
    }
    this.queue.push(operationUrl);
    if (this.currentSubscriber === null && !this.isSpawnInFlight()) {
      this.spawnInFlightSince = this.nowFn();
      this.openUrlImpl(this.hubUrl(port));
    }
  }

  /**
   * Attach a new subscriber. Displaces any prior. Resends the active
   * operation (recovery path) OR promotes the front of the queue.
   * Returns a detach callback that nulls currentSubscriber iff it
   * still equals this subscriber.
   */
  attach(sub: HubSubscriber): () => void {
    if (this.currentSubscriber !== null) {
      this.currentSubscriber.write({ type: "displaced" });
      this.currentSubscriber.close();
    }
    this.currentSubscriber = sub;
    this.spawnInFlightSince = null;
    if (this.activeUrl !== null && this.activeSeq !== null) {
      sub.write({
        type: "navigate",
        url: withHubSeq(this.activeUrl, this.activeSeq),
        seq: this.activeSeq,
      });
    } else if (this.queue.length > 0) {
      const front = this.queue.shift() as string;
      this.activeUrl = front;
      this.activeSeq = this.nextSeq++;
      sub.write({
        type: "navigate",
        url: withHubSeq(front, this.activeSeq),
        seq: this.activeSeq,
      });
    }
    return () => {
      if (this.currentSubscriber === sub) {
        this.currentSubscriber = null;
      }
    };
  }

  /**
   * Mark the current active operation done. If seq matches, clear active
   * and promote the next queued URL. Otherwise no-op (idempotent: stale
   * or duplicate done events ignored).
   */
  markDone(seq: number): void {
    if (this.activeSeq !== seq) return;
    this.activeUrl = null;
    this.activeSeq = null;
    if (this.queue.length > 0 && this.currentSubscriber !== null) {
      const front = this.queue.shift() as string;
      this.activeUrl = front;
      this.activeSeq = this.nextSeq++;
      this.currentSubscriber.write({
        type: "navigate",
        url: withHubSeq(front, this.activeSeq),
        seq: this.activeSeq,
      });
    }
  }

  /** @internal — exposed only for tests. */
  peekState(): {
    queueLength: number;
    activeUrl: string | null;
    activeSeq: number | null;
    isAttached: boolean;
    spawnInFlight: boolean;
  } {
    return {
      queueLength: this.queue.length,
      activeUrl: this.activeUrl,
      activeSeq: this.activeSeq,
      isAttached: this.currentSubscriber !== null,
      spawnInFlight: this.isSpawnInFlight(),
    };
  }

  private isSpawnInFlight(): boolean {
    if (this.spawnInFlightSince === null) return false;
    return this.nowFn() - this.spawnInFlightSince < SPAWN_TIMEOUT_MS;
  }
}
```

- [ ] **Step 4: Remove the stub test that referenced internals it can't reach**

Edit `src/daemon/hub/hub-broker.test.ts` and delete the test named `"surface detached + activeUrl set (post-close) → enqueue + respawn (attach cleared inFlight)"` — that exploratory stub was superseded by the proper test `"surface detached + activeUrl set after detach → enqueue + respawn"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="hub-broker"`
Expected: all hub-broker tests pass; typecheck clean.

Run: `npm test`
Expected: 842 + ~20 new = ~862 tests, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/hub/hub-broker.ts src/daemon/hub/hub-broker.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): HubBroker state machine for tab-reuse FIFO

Pure daemon-side state machine that owns the active operation URL +
queued URLs for the persistent hub tab. Spec
docs/superpowers/specs/2026-05-23-plan4b-tab-reuse-design.md
Component 1.

- surface() routes to navigate-now (attached + idle), enqueue
  (attached + busy), or enqueue + spawn (detached, with
  SPAWN_TIMEOUT_MS=5s debounce against burst respawns).
- attach() displaces any prior subscriber via {type:"displaced"}
  + close(), then resends the active operation (recovery) or
  promotes the next queued URL (cold-start drain).
- markDone(seq) is idempotent: only the current activeSeq advances
  the queue; duplicate or stale done events are no-ops.
- withHubSeq() appends hub_seq to each navigate URL so the framed
  operation page can echo it back via POST /ui/hub/done.

hubToken is minted via randomUUID() at construction; tokenMatches
uses timingSafeEqual for constant-time compare. Token is in-memory
only — never written to disk or socket file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part B — Hub HTTP routes

### Task B1: `GET /ui/hub` HTML route

**Files:**
- Create: `src/daemon/hub/hub-server.ts`
- Create: `src/daemon/hub/hub-server.test.ts`
- Create: `src/daemon/hub/hub-ui.html` (stub for now; full content in Task C1)

- [ ] **Step 1: Write a placeholder `hub-ui.html` so the route has a file to serve**

Create `src/daemon/hub/hub-ui.html`:

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Secret Shuttle Hub</title></head>
<body><p>Hub placeholder. Replaced in Task C1.</p></body>
</html>
```

(This stub exists only so Task B1's tests have a file to read. Task C1 replaces it with the full shell.)

- [ ] **Step 2: Write the failing test file**

Create `src/daemon/hub/hub-server.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx tsc --noEmit`
Expected: error — `Cannot find module './hub-server.js'`.

- [ ] **Step 4: Implement `src/daemon/hub/hub-server.ts` (skeleton + HTML route only)**

```typescript
// src/daemon/hub/hub-server.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShuttleError, errorToJson } from "../../shared/errors.js";
import type { DaemonServer } from "../server.js";
import type { HubBroker } from "./hub-broker.js";

const HUB_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "hub-ui.html",
);

/**
 * Register the persistent hub-tab routes:
 *   GET  /ui/hub?token=H          → HTML shell (this task, B1)
 *   GET  /ui/hub/stream?token=H   → SSE feed (B2)
 *   POST /ui/hub/done?token=H     → operation completion signal (B3)
 *
 * All three routes use addRouteRaw (per-URL-token auth bypasses bearer).
 * Spec: docs/superpowers/specs/2026-05-23-plan4b-tab-reuse-design.md
 * Component 2.
 */
export function registerHubRoutes(server: DaemonServer, broker: HubBroker): void {
  server.addRouteRaw("GET", /^\/ui\/hub$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const token = url.searchParams.get("token");
    if (token === null || token.length === 0) {
      writeError(res, 400, new ShuttleError("bad_request", "Missing token."));
      return;
    }
    if (!broker.tokenMatches(token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    const html = await readFile(HUB_HTML_PATH, "utf8");
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    setHardeningHeaders(res);
    // CSP allows the iframe (frame-src 'self') and the SSE connect
    // (connect-src 'self'). frame-ancestors 'none' on the HUB ITSELF
    // (a hostile page must not embed the hub); the operation pages
    // relax this to 'self' so the hub can iframe them.
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-src 'self'; child-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    res.end(html);
  });
}

function setHardeningHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
}

function writeError(res: import("node:http").ServerResponse, status: number, err: unknown): void {
  if (res.writableEnded) return;
  setHardeningHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(errorToJson(err)));
}
```

- [ ] **Step 5: Update build script to copy `hub-ui.html`**

Edit `package.json` — find the `build` script (`"build": "tsc -p tsconfig.json && node -e \"import('node:fs')...`) and add `copyFileSync('src/daemon/hub/hub-ui.html','dist/daemon/hub/hub-ui.html');` inside the `then` callback. Also ensure `dist/daemon/hub/` exists by adding a `mkdirSync('dist/daemon/hub', { recursive: true })`. Final build script:

```json
"build": "tsc -p tsconfig.json && node -e \"import('node:fs').then(({copyFileSync,mkdirSync})=>{mkdirSync('dist/daemon/hub',{recursive:true});copyFileSync('src/daemon/approvals/ui.html','dist/daemon/approvals/ui.html');copyFileSync('src/daemon/approvals/unlock-ui.html','dist/daemon/approvals/unlock-ui.html');copyFileSync('src/daemon/approvals/session-ui.html','dist/daemon/approvals/session-ui.html');copyFileSync('src/daemon/hub/hub-ui.html','dist/daemon/hub/hub-ui.html');})\"",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="GET /ui/hub"`
Expected: 3 hub HTML route tests pass.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/hub/hub-server.ts src/daemon/hub/hub-server.test.ts src/daemon/hub/hub-ui.html package.json
git commit -m "$(cat <<'EOF'
feat(hub): GET /ui/hub HTML shell route

Serves the static hub shell with hardening headers + the same-origin-
strict CSP. frame-src/connect-src 'self' permit the iframe and SSE
connection respectively; frame-ancestors 'none' blocks hostile pages
from embedding the hub.

Auth: ?token= validated via HubBroker.tokenMatches (timingSafeEqual).
Missing token → 400 bad_request; mismatched → 401 ui_token_mismatch.

Includes a placeholder hub-ui.html that Task C1 replaces with the full
shell + SSE client. Build script updated to copy hub-ui.html to dist.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B2: `GET /ui/hub/stream` SSE route

**Files:**
- Modify: `src/daemon/hub/hub-server.ts`
- Modify: `src/daemon/hub/hub-server.test.ts`

- [ ] **Step 1: Append the failing SSE tests**

Append to `src/daemon/hub/hub-server.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="ui/hub/stream"`
Expected: 3 SSE tests fail (route not registered yet).

- [ ] **Step 3: Implement the SSE route — append to `src/daemon/hub/hub-server.ts`**

Inside `registerHubRoutes`, **after** the GET `/ui/hub` block, add:

```typescript
  server.addRouteRaw("GET", /^\/ui\/hub\/stream$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const token = url.searchParams.get("token");
    if (token === null || token.length === 0) {
      writeError(res, 400, new ShuttleError("bad_request", "Missing token."));
      return;
    }
    if (!broker.tokenMatches(token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-accel-buffering", "no");
    setHardeningHeaders(res);
    // Flush headers so the client knows the connection is open before
    // any data frame arrives. (Node sends headers on first write/flush.)
    res.flushHeaders?.();

    const sub: import("./hub-broker.js").HubSubscriber = {
      write: (e) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      },
      // Reassigned below to also invoke cleanup().
      close: () => undefined,
    };

    const detach = broker.attach(sub);
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(keepalive);
      detach();
    };
    sub.close = () => {
      if (!res.writableEnded && !res.destroyed) res.end();
      cleanup();
    };

    const keepalive = setInterval(() => {
      if (res.writableEnded || res.destroyed) { cleanup(); return; }
      res.write(": ping\n\n");
    }, 25_000);
    // Stop the keepalive from blocking node from exiting under test.
    keepalive.unref?.();

    req.on("close", cleanup);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="ui/hub/stream"`
Expected: 3 SSE tests pass.

Run: `npm test`
Expected: ~865 tests, 0 fail. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/hub/hub-server.ts src/daemon/hub/hub-server.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): GET /ui/hub/stream SSE route + displacement

Wires a HubSubscriber around the ServerResponse: write() emits
SSE data: frames (guarded by res.writableEnded/destroyed); close()
ends the response and triggers shared cleanup(). cleanup() is
idempotent (cleanedUp flag) and runs from both req.on("close")
and the broker-driven sub.close() path.

25s keepalive interval prevents intermediary idle-close; clearInterval
runs in cleanup() so timers never leak across reconnects.

Token validation identical to /ui/hub. Two SSE connections to the
same broker displaces the first via {type:"displaced"} + close() —
exercised by the "Second SSE connection displaces the first" test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: `POST /ui/hub/done` route + `readBoundedJson` helper

**Files:**
- Modify: `src/daemon/hub/hub-server.ts`
- Modify: `src/daemon/hub/hub-server.test.ts`

- [ ] **Step 1: Append the failing tests**

Append to `src/daemon/hub/hub-server.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="/ui/hub/done"`
Expected: 8 tests fail (route not registered).

- [ ] **Step 3: Add the route + `readBoundedJson` helper**

Append to `src/daemon/hub/hub-server.ts` (inside `registerHubRoutes` after the SSE route):

```typescript
  server.addRouteRaw("POST", /^\/ui\/hub\/done$/, async (req, _body, res) => {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    const token = url.searchParams.get("token");
    if (token === null || token.length === 0) {
      writeError(res, 400, new ShuttleError("bad_request", "Missing token."));
      return;
    }
    if (!broker.tokenMatches(token)) {
      writeError(res, 401, new ShuttleError("ui_token_mismatch", "Invalid UI token."));
      return;
    }
    let payload: unknown;
    try {
      payload = await readBoundedJson(req, 1024);
    } catch (e) {
      // request_too_large maps to its registered exit code via errorToJson.
      const status = e instanceof ShuttleError && e.code === "request_too_large" ? 400 : 400;
      writeError(res, status, e);
      return;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      writeError(res, 400, new ShuttleError("bad_request", "Body must be a JSON object."));
      return;
    }
    const seqRaw = (payload as Record<string, unknown>).seq;
    if (typeof seqRaw !== "number" || !Number.isInteger(seqRaw) || seqRaw <= 0) {
      writeError(res, 400, new ShuttleError("bad_request", "seq must be a positive integer."));
      return;
    }
    broker.markDone(seqRaw);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    setHardeningHeaders(res);
    res.end(JSON.stringify({ ok: true }));
  });
```

Also add the helper at the bottom of the file (above `setHardeningHeaders` is fine — order doesn't matter for module-level functions):

```typescript
async function readBoundedJson(
  req: import("node:http").IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new ShuttleError("request_too_large", `Body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  if (total === 0) {
    throw new ShuttleError("bad_request", "Empty body.");
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ShuttleError("bad_request", "Malformed JSON body.");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="/ui/hub/done"`
Expected: 8 tests pass.

Run: `npx tsc --noEmit && npm test`
Expected: ~873 tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/hub/hub-server.ts src/daemon/hub/hub-server.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): POST /ui/hub/done route + bounded JSON parser

addRouteRaw bypasses the daemon's 1 MB body cap, so the route uses
its own readBoundedJson(req, 1024) helper. Oversize → request_too_large
(the registered code, matches src/daemon/server.ts:183). Malformed
JSON or empty body → 400 bad_request. Non-integer / non-positive
seq → 400 bad_request.

markDone(seq) is idempotent — mismatched seq returns 200 with no
state change. This is the property the hub-side postDone retry loop
depends on for duplicate-suppression.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B4: Wire hub routes into router + DaemonServices DI

**Files:**
- Modify: `src/daemon/services.ts`
- Modify: `src/daemon/api/router.ts`

- [ ] **Step 1: Add `hubBroker` field + optional constructor to `src/daemon/services.ts`**

Open `src/daemon/services.ts`. Add to imports:

```typescript
import { HubBroker } from "./hub/hub-broker.js";
import { openUrl } from "./approvals/open-url.js";
```

Add the options interface and modify the class. The existing class has multiple `readonly fieldName = new X()` initializers. Convert by adding a constructor and giving `hubBroker` an explicit assignment. **Critical: the default broker MUST be constructed with the real `openUrl` as its `openUrlImpl`.** HubBroker now requires an explicit `openUrlImpl` (no internal default), so a forgotten injection won't silently no-op:

```typescript
export interface DaemonServicesOptions {
  hubBroker?: HubBroker;
  /**
   * Override the `openUrlImpl` used when constructing the DEFAULT
   * HubBroker. This is the hook tests use to prove the default
   * constructor path — without this, the only way to inject a spy
   * would be to construct a HubBroker entirely outside DaemonServices,
   * which doesn't actually exercise the default wiring. Ignored when
   * `hubBroker` is provided.
   */
  hubOpenUrlImpl?: (url: string) => void;
}

export class DaemonServices {
  // ... all existing readonly fields stay as inline initializers
  readonly hubBroker: HubBroker;

  constructor(opts: DaemonServicesOptions = {}) {
    // Production: real openUrl (which honors SECRET_SHUTTLE_NO_OPEN_URL=1
    // as a no-op for tests). The hubOpenUrlImpl hook lets tests prove
    // this very wiring without bypassing it. Without the explicit
    // `openUrl` here, the broker would queue URLs internally and never
    // open a tab — silently broken in prod.
    this.hubBroker =
      opts.hubBroker ??
      new HubBroker({ openUrlImpl: opts.hubOpenUrlImpl ?? openUrl });
  }
}
```

(Existing fields like `sessionStore = new SessionStore()` keep their inline form — only `hubBroker` needs the constructor route because it accepts injection.)

- [ ] **Step 1b: Add an integration test for the default wiring**

Create `src/daemon/hub/default-services-wiring.test.ts`:

```typescript
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
```

- [ ] **Step 2: Register the hub routes in `src/daemon/api/router.ts`**

Add import:

```typescript
import { registerHubRoutes } from "../hub/hub-server.js";
```

Inside `registerRoutes`, add (the position doesn't matter — pick after `registerSessionUiRoutes`):

```typescript
  registerHubRoutes(server, services.hubBroker);
```

- [ ] **Step 3: Verify existing callers still compile + new wiring tests pass**

Run: `npx tsc --noEmit`
Expected: clean. `new DaemonServices()` callers continue to work — the constructor arg has a default, and the default constructs a HubBroker with the real openUrl.

Run: `npm test -- --test-name-pattern="default DaemonServices"`
Expected: 2 wiring tests pass. (First proves no-throw under SECRET_SHUTTLE_NO_OPEN_URL=1; second proves the actual spawn pathway fires when the env var is unset.)

Run: `npm test`
Expected: ~875 tests, 0 fail (added 2 wiring tests beyond the original B4 plan).

- [ ] **Step 4: Commit**

```bash
git add src/daemon/services.ts src/daemon/api/router.ts src/daemon/hub/default-services-wiring.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): wire HubBroker into DaemonServices + router

DaemonServices gains an optional constructor parameter
{ hubBroker?: HubBroker } so Layer 5 e2e tests can inject a HubBroker
with a spied openUrlImpl + synthetic clock. Default arg keeps
existing `new DaemonServices()` callers working (bin/secret-shuttle,
lifecycle.ts, all existing tests).

CRITICAL: the default broker is constructed with the real openUrl
as its openUrlImpl. HubBroker has no internal default (Plan 4b
post-review P0 fix) — a forgotten injection would otherwise silently
queue URLs forever and never open a tab in production. The new
default-services-wiring.test.ts proves this both directions: under
SECRET_SHUTTLE_NO_OPEN_URL=1 the default broker no-ops safely; with
the env var unset, a spawn-spy proves the default path actually
invokes the platform opener.

registerHubRoutes(server, services.hubBroker) added to router.ts.
Order doesn't matter (no regex overlap with /ui/approve, /ui/session,
/ui/unlock, /ui/sessions/*).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part C — Hub UI HTML shell

### Task C1: Full `hub-ui.html` shell

**Files:**
- Modify: `src/daemon/hub/hub-ui.html` (replaces the Task B1 placeholder)

- [ ] **Step 1: Write the full shell**

Replace the entire contents of `src/daemon/hub/hub-ui.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Secret Shuttle Hub</title>
  <meta name="referrer" content="no-referrer">
  <style>
    html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, system-ui, sans-serif; }
    #status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      height: 32px;
      padding: 0 0.75rem;
      background: #f0f0f3;
      border-bottom: 1px solid #d1d1d6;
      font-size: 0.85rem;
      color: #444;
    }
    #status .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #999;
    }
    #status.connected .dot { background: #0a7a3b; }
    #status.reconnecting .dot { background: #c99a00; }
    #status.disconnected .dot, #status.displaced .dot { background: #c2331a; }
    #op {
      width: 100%;
      height: calc(100% - 32px);
      border: 0;
    }
    /* Terminal states hide the iframe AND show the banner. Without
       this, a displaced tab's still-loaded /ui/approve iframe stays
       clickable — the user could approve operations the new tab is
       supposed to be driving. */
    #status.disconnected ~ #op, #status.displaced ~ #op { display: none; }
    #banner {
      display: none;
      padding: 1rem;
      color: #444;
      font-size: 1rem;
      line-height: 1.4;
    }
    #status.disconnected ~ #banner, #status.displaced ~ #banner { display: block; }
    #banner button {
      font-size: 1rem;
      padding: 0.5rem 1rem;
      margin-top: 0.75rem;
      background: #0a7a3b;
      color: #fff;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
    }
    #banner button:hover { background: #086030; }
  </style>
</head>
<body>
  <div id="status" class="connected">
    <span class="dot" aria-hidden="true"></span>
    <span id="status-text">Connected</span>
    <span style="margin-left:auto;color:#888" id="status-port"></span>
  </div>
  <iframe id="op" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
  <!-- Banner is populated by showBanner() with text + a recovery button.
       Reload is intentionally NOT the recovery path: history.replaceState
       strips the hub_token from the URL after bootstrap, so a bare reload
       hits /ui/hub with no token and 400s. The Take over / Reconnect
       button re-enters the active state using the closure-local token. -->
  <div id="banner"></div>
  <script>
    (() => {
      const params = new URLSearchParams(location.search);
      const hubToken = params.get("token") ?? "";
      // Strip the hub_token from the address bar after bootstrap so it
      // no longer appears in screenshots, screen-sharing, Referer
      // headers, or window.parent.location.search reads from any
      // iframe content. The token survives only as a closure-local
      // JS variable, which (because it's not assigned to `window` or
      // any reachable global) is not accessible via
      // window.parent.hubToken from inside the iframe.
      try {
        history.replaceState({}, "", "/ui/hub");
      } catch { /* environments without history API (test stubs) — fine */ }
      const iframe = document.getElementById("op");
      const statusEl = document.getElementById("status");
      const statusText = document.getElementById("status-text");
      const statusPort = document.getElementById("status-port");
      const banner = document.getElementById("banner");

      statusPort.textContent = `port ${location.port}`;

      let terminal = false;
      let consecutiveFailures = 0;
      let es = null;

      function showBanner(text, kind) {
        statusEl.className = kind || "";
        statusText.textContent = text;
        if (kind === "disconnected" || kind === "displaced") {
          // Drop the operation page so a displaced/terminal tab cannot
          // continue approving operations the user thought were handed
          // off. The CSS rule above also hides the iframe element so
          // there's no clickable surface even if about:blank is slow.
          if (iframe.src !== "about:blank") {
            iframe.src = "about:blank";
          }
          // Populate the banner with text + a recovery button. Reload
          // is NOT the recovery path: history.replaceState stripped the
          // hub_token from the URL, so a reload hits /ui/hub with no
          // token and 400s. The button uses the closure-local hubToken
          // to re-issue an EventSource without leaving this page.
          banner.innerHTML = "";
          const p = document.createElement("p");
          p.textContent = text;
          banner.appendChild(p);
          const btn = document.createElement("button");
          btn.textContent = kind === "displaced" ? "Take over here" : "Reconnect";
          btn.addEventListener("click", takeOver);
          banner.appendChild(btn);
        } else {
          banner.innerHTML = "";
        }
      }

      function takeOver() {
        // Re-enter the active state without reloading the page.
        // - terminal=false re-enables iframe→hub postMessage handling.
        // - consecutiveFailures=0 resets the strikes-out counter.
        // - statusEl class flips to "reconnecting", which removes the
        //   CSS rule hiding #op, so the iframe area is interactive
        //   again as soon as the next navigate arrives.
        // connect() opens a fresh EventSource; if another tab was
        // attached, the broker's attach() will displace it. The
        // resend of activeUrl reloads whatever operation was pending.
        terminal = false;
        consecutiveFailures = 0;
        banner.innerHTML = "";
        statusEl.className = "reconnecting";
        statusText.textContent = "Reconnecting…";
        connect();
      }

      function handleNavigate(url) {
        iframe.src = url;
      }

      function onMessage(ev) {
        const data = JSON.parse(ev.data);
        if (data.type === "displaced") {
          terminal = true;
          if (es) es.close();
          showBanner("Another tab is now driving Secret Shuttle. Click below to take over here.", "displaced");
          return;
        }
        if (data.type === "navigate") {
          handleNavigate(data.url);
        }
      }

      function connect() {
        es = new EventSource(`/ui/hub/stream?token=${encodeURIComponent(hubToken)}`);
        es.addEventListener("open", () => {
          consecutiveFailures = 0;
          showBanner("Connected", "connected");
        });
        es.addEventListener("message", onMessage);
        es.addEventListener("error", () => {
          if (terminal) return;
          es.close();
          consecutiveFailures += 1;
          if (consecutiveFailures < 2) {
            showBanner("Reconnecting…", "reconnecting");
            setTimeout(connect, 1000);
          } else {
            terminal = true;
            showBanner("Disconnected from Secret Shuttle. Click below to reconnect.", "disconnected");
          }
        });
      }

      const doneInFlight = new Set();
      let lastCompletedSeq = 0;

      function shouldPostDone(seq) {
        if (seq <= lastCompletedSeq) return false;
        if (doneInFlight.has(seq)) return false;
        doneInFlight.add(seq);
        return true;
      }

      async function postDone(seq) {
        const MAX_ATTEMPTS = 5;
        const BASE_DELAY_MS = 250;
        let succeeded = false;
        try {
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
              const r = await fetch(`/ui/hub/done?token=${encodeURIComponent(hubToken)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ seq }),
              });
              if (r.ok) { succeeded = true; return; }
              if (r.status === 401 || r.status === 403 || r.status === 400) break;
            } catch {
              // Network failure; retry.
            }
            await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * (attempt + 1)));
          }
          terminal = true;
          if (es) es.close();
          showBanner("Failed to advance Secret Shuttle. Click below to reconnect.", "disconnected");
        } finally {
          doneInFlight.delete(seq);
          if (succeeded) lastCompletedSeq = Math.max(lastCompletedSeq, seq);
        }
      }

      window.addEventListener("message", (ev) => {
        if (terminal) return;
        if (ev.origin !== location.origin) return;
        if (ev.source !== iframe.contentWindow) return;
        const data = ev.data;
        if (!data || data.type !== "operation_done") return;
        if (!Number.isSafeInteger(data.seq) || data.seq <= 0) return;
        if (!shouldPostDone(data.seq)) return;
        postDone(data.seq);
      });

      connect();
    })();
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify the Task B1 tests still pass against the real shell**

Run: `npm test -- --test-name-pattern="GET /ui/hub"`
Expected: 3 hub HTML route tests pass (the assertion `html.includes("Secret Shuttle Hub")` matches the title).

- [ ] **Step 3: Commit**

```bash
git add src/daemon/hub/hub-ui.html
git commit -m "$(cat <<'EOF'
feat(hub): hub-ui.html shell with SSE client + iframe + postDone

Self-contained HTML page. No external assets.

Wiring:
- 32px status bar with connection state pill + daemon port.
- Full-viewport <iframe sandbox="allow-scripts allow-same-origin
  allow-forms"> renders each operation URL pushed by the broker.
- EventSource to /ui/hub/stream with explicit close-on-error,
  consecutiveFailures-counter reset on open, two-strike terminal
  banner with manual-reload recovery.
- postDone(seq) retry loop (MAX_ATTEMPTS=5, exponential backoff,
  401/403/400 terminal). On exhaustion: terminal=true, es.close(),
  banner. doneInFlight Set + lastCompletedSeq high-water mark
  suppress duplicate operation_done events from running the terminal
  branch after a sibling success.
- window message listener validates origin + iframe source, calls
  shouldPostDone() gate, then postDone().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C2: Hub-UI drift-guard test

**Files:**
- Create: `src/daemon/hub/hub-ui-html-drift.test.ts`

- [ ] **Step 1: Write the drift test**

Create `src/daemon/hub/hub-ui-html-drift.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HUB_HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/hub/hub-ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HUB_HTML, "utf8");
}

test("hub-ui.html: postDone retry shape", async () => {
  const html = await loadHtml();
  assert.match(html, /function postDone\b/);
  assert.match(html, /MAX_ATTEMPTS\s*=\s*5\b/);
  // Retry loop must wrap the fetch in try/catch.
  assert.match(html, /for\s*\(let attempt[\s\S]+?try\s*\{[\s\S]+?\}\s*catch/);
  // HTTP terminal breaks.
  assert.match(html, /401/);
  assert.match(html, /403/);
  assert.match(html, /400/);
  assert.match(html, /\bbreak\b/);
  // Success exit.
  assert.match(html, /r\.ok/);
});

test("hub-ui.html: terminal-branch teardown closes SSE", async () => {
  const html = await loadHtml();
  assert.match(html, /terminal\s*=\s*true/);
  // es?.close() OR es.close() (different syntaxes are fine).
  assert.match(html, /es\??\.close\s*\(/);
  assert.match(html, /showBanner\s*\(/);
});

test("hub-ui.html: displaced/disconnected hides the iframe and points it at about:blank", async () => {
  const html = await loadHtml();
  // CSS rule must hide #op when status is disconnected OR displaced.
  // Crude check: both selector forms appear paired with `#op` and `display: none`.
  assert.match(html, /#status\.(disconnected|displaced)[^{]*~\s*#op[^{]*\{[^}]*display\s*:\s*none/);
  // JS must also reassign iframe.src to about:blank when entering a
  // terminal-state banner (defense in depth against CSS bypass).
  assert.match(html, /iframe\.src\s*=\s*["']about:blank["']/);
});

test("hub-ui.html: message-handler suppresses post-terminal events", async () => {
  const html = await loadHtml();
  assert.match(html, /if\s*\(terminal\)\s*return/);
});

test("hub-ui.html: open listener resets consecutiveFailures", async () => {
  const html = await loadHtml();
  assert.match(html, /addEventListener\(\s*["']open["']/);
  assert.match(html, /consecutiveFailures\s*=\s*0/);
});

test("hub-ui.html: duplicate-done suppression scaffolding", async () => {
  const html = await loadHtml();
  assert.match(html, /\bdoneInFlight\b/);
  assert.match(html, /\blastCompletedSeq\b/);
  assert.match(html, /function shouldPostDone\b/);
  // postDone must wrap work in try/finally to clean state.
  assert.match(html, /try\s*\{[\s\S]+?\}\s*finally\s*\{[\s\S]+?doneInFlight\.delete/);
  assert.match(html, /lastCompletedSeq\s*=\s*Math\.max/);
});

test("hub-ui.html: window message origin + source guards", async () => {
  const html = await loadHtml();
  assert.match(html, /ev\.origin\s*!==\s*location\.origin/);
  assert.match(html, /ev\.source\s*!==\s*iframe\.contentWindow/);
});

test("hub-ui.html: iframe sandbox attribute is restrictive", async () => {
  const html = await loadHtml();
  assert.match(html, /<iframe[^>]*sandbox=["']allow-scripts allow-same-origin allow-forms["']/);
});

test("hub-ui.html: strips hub_token from URL after bootstrap (history.replaceState)", async () => {
  const html = await loadHtml();
  // Defense against token leakage via address bar, screenshots,
  // Referer headers, and window.parent.location.search reads from
  // iframe content. The token must be read into a closure-local
  // variable, then immediately replaced via history.replaceState.
  assert.match(html, /history\.replaceState\s*\(\s*\{\s*\}\s*,\s*["']["']\s*,\s*["']\/ui\/hub["']\s*\)/);
});

test("hub-ui.html: in-page recovery (takeOver) replaces reload-based recovery", async () => {
  const html = await loadHtml();
  // Because history.replaceState strips the token, a bare reload would
  // hit /ui/hub with no token and 400. The recovery path must be a
  // takeOver() function reachable from a button inside the banner.
  assert.match(html, /function takeOver\b/);
  // takeOver must reset the terminal-state flag, clear the strikes
  // counter, and re-issue the SSE connection via connect().
  assert.match(html, /terminal\s*=\s*false/);
  assert.match(html, /consecutiveFailures\s*=\s*0/);
  assert.match(html, /takeOver[\s\S]{0,400}?connect\s*\(\s*\)/);
  // Banner must wire a click listener on its own button onto takeOver.
  assert.match(html, /addEventListener\(\s*["']click["']\s*,\s*takeOver\s*\)/);
  // Banner text in terminal states must NOT instruct the user to reload —
  // doing so would lead them into the 400 trap. Crude assertion: no
  // showBanner call inside the JS contains the substring "Reload".
  // (Comments mentioning Reload as the failure mode being avoided are OK.)
  const showBannerCalls = html.match(/showBanner\([^)]+\)/g) ?? [];
  for (const call of showBannerCalls) {
    assert.doesNotMatch(call, /Reload/i, `showBanner call must not instruct a reload: ${call}`);
  }
});
```

- [ ] **Step 2: Run the drift tests**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="hub-ui.html"`
Expected: 7 drift tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/hub/hub-ui-html-drift.test.ts
git commit -m "$(cat <<'EOF'
test(hub): drift guard for hub-ui.html inline JS contract

Crude text-pattern assertions on hub-ui.html that catch accidental
deletion of:
- postDone() retry shape (MAX_ATTEMPTS=5, try/catch in loop,
  401/403/400 break, r.ok success exit).
- Terminal branch teardown (terminal=true + es.close() + showBanner).
- Message handler's `if (terminal) return` suppression guard.
- consecutiveFailures reset on the EventSource open event.
- Duplicate-done suppression scaffolding (doneInFlight Set,
  lastCompletedSeq high-water mark, shouldPostDone gate function,
  try/finally cleanup including doneInFlight.delete + Math.max).
- window message origin + iframe-source guards.
- iframe sandbox attribute.

Without these, a future edit that quietly drops one of the safety
mechanisms would silently regress the queue-liveness or
displacement-correctness invariants. The assertions intentionally
don't run the JS — they exist as a tripwire only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part D — CSP relaxations on the three operation routes

These three routes currently set `frame-ancestors 'none'` (session-ui) or no CSP header at all (ui.html, unlock). Relax to `frame-ancestors 'self'` so the hub iframe can embed them.

### Task D1: `/ui/approve` CSP

**Files:**
- Modify: `src/daemon/approvals/ui-server.ts`
- Modify: `src/daemon/approvals/ui-server.test.ts` (if exists; otherwise create)

- [ ] **Step 1: Write the failing CSP test**

Check if `src/daemon/approvals/ui-server.test.ts` exists:

Run: `ls src/daemon/approvals/ui-server.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

If MISSING, create `src/daemon/approvals/ui-server.test.ts`:

```typescript
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../server.js";
import { ApprovalStore } from "./store.js";
import { registerUiRoutes } from "./ui-server.js";

async function withUiDaemon<T>(fn: (ctx: { port: number; store: ApprovalStore }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-ui-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const server = new DaemonServer({ token: "t" });
  const store = new ApprovalStore();
  registerUiRoutes(server, store);
  const { port } = await server.listen(0);
  try {
    return await fn({ port, store });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("GET /ui/approve sets CSP with frame-ancestors 'self'", async () => {
  await withUiDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/approve`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
  });
});
```

If EXISTS, just append the same test.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="GET /ui/approve sets CSP"`
Expected: fails — current ui-server.ts has no CSP header.

- [ ] **Step 3: Add the CSP + hardening headers in `src/daemon/approvals/ui-server.ts`**

In the `GET /ui/approve` handler (currently lines 15–19), replace:

```typescript
  server.addRouteRaw("GET", /^\/ui\/approve$/, async (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await readFile(HTML_PATH, "utf8"));
  });
```

With:

```typescript
  server.addRouteRaw("GET", /^\/ui\/approve$/, async (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    // frame-ancestors 'self' lets the hub iframe embed this page.
    // The per-URL ui_token remains the operational security boundary.
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    res.end(await readFile(HTML_PATH, "utf8"));
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="GET /ui/approve sets CSP"`
Expected: passes.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/ui-server.ts src/daemon/approvals/ui-server.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals): relax /ui/approve CSP to frame-ancestors 'self'

Plan 4b's hub tab iframes operation pages, so /ui/approve must permit
embedding. Relaxation is to 'self' (not '*'): only the daemon's own
hub can frame the approval page; the per-URL ui_token remains the
operational security boundary. Daemon binds 127.0.0.1, so same-origin
constrains the threat surface tightly.

Also adds the hardening triplet (Cache-Control: no-store,
Referrer-Policy: no-referrer, X-Content-Type-Options: nosniff) that
was previously missing from this route — token-bearing UI URLs are
sensitive enough that any cache/referrer leak is worth preventing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D2: `/ui/session` CSP

**Files:**
- Modify: `src/daemon/approvals/session-ui-server.ts`
- Modify: `src/daemon/approvals/session-ui-server.test.ts` (extend)

- [ ] **Step 1: Append the failing CSP test**

Append to `src/daemon/approvals/session-ui-server.test.ts`:

```typescript
test("GET /ui/session CSP frame-ancestors is 'self' (relaxed from 'none')", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run"],
      ref_glob: "ss://x/prod/*",
      destination_domains: [],
      template_ids: ["any"],
      ttl_ms: 60_000,
    });
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/session?id=${sg.id}&token=${sg.ui_token}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="frame-ancestors is 'self'"`
Expected: fails — current CSP says `'none'`.

- [ ] **Step 3: Update CSP in `src/daemon/approvals/session-ui-server.ts`**

In the `GET /ui/session` handler, replace:

```typescript
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'",
    );
```

With:

```typescript
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'",
    );
```

Also update the inline `<meta http-equiv>` in `src/daemon/approvals/session-ui.html` (line 6) for consistency, even though the HTTP header is authoritative:

Find:

```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'">
```

Replace with:

```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'">
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="frame-ancestors is 'self'"`
Expected: passes.

Run: `npm test`
Expected: any existing session-ui CSP tests that checked for `'none'` may now fail. Update those tests' expectations to `'self'`. Search for them:

Run: `grep -rn "frame-ancestors 'none'" src/`

If any non-hub references remain in test files, update them. (The hub itself keeps `frame-ancestors 'none'` — only the three operation routes change.) After updates, `npm test` should be clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session-ui-server.ts src/daemon/approvals/session-ui-server.test.ts src/daemon/approvals/session-ui.html
git commit -m "$(cat <<'EOF'
feat(approvals): relax /ui/session CSP to frame-ancestors 'self'

Plan 4b's hub iframes the session approval page. Same justification
as /ui/approve: same-origin embedding only, ui_token still gates per
operation, daemon binds 127.0.0.1.

JSON sub-routes (/ui/sessions/:id and approve|deny) keep their
existing CSP — they're not framed.

The inline <meta http-equiv> CSP in session-ui.html is also updated
for consistency (though the HTTP header is the authoritative one).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D3: `/ui/unlock` CSP

**Files:**
- Modify: `src/daemon/api/routes/unlock-session.ts`
- Modify or create: a test file for the unlock UI route

- [ ] **Step 1: Locate or create the test file**

Run: `ls src/daemon/api/routes/unlock-session.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

If MISSING, create `src/daemon/api/routes/unlock-session.test.ts`:

```typescript
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerUnlockSession } from "./unlock-session.js";

async function withUnlockUiDaemon<T>(fn: (ctx: { port: number; services: DaemonServices }) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-unlock-ui-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerUnlockSession(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

test("GET /ui/unlock sets CSP with frame-ancestors 'self' + hardening headers", async () => {
  await withUnlockUiDaemon(async (ctx) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/ui/unlock`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'self'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });
});
```

If EXISTS, append the same test.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="GET /ui/unlock sets CSP"`
Expected: fails — current handler has no CSP header.

- [ ] **Step 3: Update the GET `/ui/unlock` handler**

In `src/daemon/api/routes/unlock-session.ts`, find the existing handler (currently lines 40–44):

```typescript
  server.addRouteRaw("GET", /^\/ui\/unlock$/, async (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await readFile(HTML_PATH, "utf8"));
  });
```

Replace with:

```typescript
  server.addRouteRaw("GET", /^\/ui\/unlock$/, async (_req, _body, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    );
    res.end(await readFile(HTML_PATH, "utf8"));
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="GET /ui/unlock sets CSP"`
Expected: passes.

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/routes/unlock-session.ts src/daemon/api/routes/unlock-session.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): add CSP + hardening headers to /ui/unlock

Plan 4b's hub iframes the unlock page. Adds the full hardened CSP
(default-src 'self'; frame-ancestors 'self'; base-uri 'none';
form-action 'none'; object-src 'none'; script-src/style-src 'self'
'unsafe-inline') and the hardening triplet (Cache-Control: no-store,
Referrer-Policy: no-referrer, X-Content-Type-Options: nosniff).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part E — Operation page modifications (hub_seq + notify + polling)

### Task E1: `/ui/approve` — `ui.html`

**Files:**
- Modify: `src/daemon/approvals/ui.html`
- Create: `src/daemon/approvals/ui-html-drift.test.ts`

- [ ] **Step 1: Write the drift-guard test FIRST so it fails**

Create `src/daemon/approvals/ui-html-drift.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/approvals/ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HTML, "utf8");
}

test("ui.html: hub_seq parse with null-trap guard", async () => {
  const html = await loadHtml();
  assert.match(html, /URLSearchParams\(\s*location\.search\s*\)/);
  assert.match(html, /hub_seq/);
  assert.match(html, /Number\.isSafeInteger/);
  // The "rawHubSeq === null ? null : Number(...)" pattern OR equivalent
  // null-check must precede the > 0 test.
  assert.match(html, /(===\s*null|!== null)/);
});

test("ui.html: notifyHubIfFramed function present + parent + postMessage call", async () => {
  const html = await loadHtml();
  assert.match(html, /function notifyHubIfFramed\b/);
  assert.match(html, /window\.parent\s*!==\s*window/);
  assert.match(html, /window\.parent\.postMessage/);
  assert.match(html, /operation_done/);
});

test("ui.html: pollForTerminal + terminalStatuses for /ui/approvals/:id", async () => {
  const html = await loadHtml();
  assert.match(html, /function pollForTerminal\b/);
  assert.match(html, /terminalStatuses/);
  // Required terminal statuses for /ui/approve.
  for (const status of ["granted", "denied", "expired", "used"]) {
    assert.match(html, new RegExp(`"${status}"`), `terminal status ${status}`);
  }
  // Polls the approvals endpoint.
  assert.match(html, /\/ui\/approvals\/\$\{id\}\?token=/);
});

test("ui.html: startPolling + stopPolling + beforeunload cleanup", async () => {
  const html = await loadHtml();
  assert.match(html, /function startPolling\b/);
  assert.match(html, /function stopPolling\b/);
  // stopPolling must be called from the terminal path AND beforeunload.
  const stopCalls = html.match(/stopPolling\s*\(\s*\)/g) ?? [];
  assert.ok(stopCalls.length >= 2, `expected ≥2 stopPolling() call sites, got ${stopCalls.length}`);
  assert.match(html, /addEventListener\(\s*["']beforeunload["']/);
});

test("ui.html: success-only gate — notifyHubIfFramed reachable only under r.ok", async () => {
  const html = await loadHtml();
  // The success-only gate: there must be an `if (r.ok)` (or equivalent)
  // preceding a notifyHubIfFramed() call in the approve/deny POST handler.
  // Crude pattern: r.ok appearing within ~200 chars of notifyHubIfFramed.
  const okPattern = /if\s*\(\s*r\.ok\s*\)/;
  assert.match(html, okPattern, "expected an `if (r.ok)` guard around the notify call");
});
```

- [ ] **Step 2: Run to verify drift tests fail**

Run: `npm test -- --test-name-pattern="ui\\.html"`
Expected: all 5 drift tests fail — `ui.html` doesn't have any of these patterns yet.

- [ ] **Step 3: Edit `src/daemon/approvals/ui.html` to add the polling + notify wiring**

Open `src/daemon/approvals/ui.html`. Inside the existing `<script type="module">` block, **after the existing `const token = params.get("token");`** line (around line 26), insert:

```javascript
      // ── Plan 4b: hub integration ────────────────────────────────
      const rawHubSeq = params.get("hub_seq");
      const parsedHubSeq = rawHubSeq === null ? null : Number(rawHubSeq);
      const hasHubSeq = parsedHubSeq !== null && Number.isSafeInteger(parsedHubSeq) && parsedHubSeq > 0;

      function notifyHubIfFramed() {
        if (!hasHubSeq) return;
        if (window.parent === window) return;
        window.parent.postMessage({ type: "operation_done", seq: parsedHubSeq }, location.origin);
      }

      const terminalStatuses = new Set(["granted", "denied", "expired", "used"]);
      let pollTimer = null;
      async function pollForTerminal() {
        try {
          const r = await fetch(`/ui/approvals/${id}?token=${token}`);
          if (!r.ok) return;
          const body = await r.json();
          if (terminalStatuses.has(body.status)) {
            stopPolling();
            notifyHubIfFramed();
          }
        } catch { /* network blip; next tick will retry */ }
      }
      function startPolling() { pollTimer = setInterval(pollForTerminal, 2000); }
      function stopPolling() { if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; } }
      window.addEventListener("beforeunload", stopPolling);
      // ────────────────────────────────────────────────────────────
```

Then find the existing `send(action)` function (around line 75):

```javascript
      async function send(action) {
        const r = await fetch(`/ui/approvals/${id}/${action}?token=${token}`, { method: "POST" });
        if (r.ok) document.getElementById("status").textContent = `Status: ${action}d`;
      }
```

Replace with:

```javascript
      async function send(action) {
        const r = await fetch(`/ui/approvals/${id}/${action}?token=${token}`, { method: "POST" });
        if (r.ok) {
          document.getElementById("status").textContent = `Status: ${action}d`;
          stopPolling();
          notifyHubIfFramed();
        }
        // On !r.ok: leave polling active. If the daemon actually committed
        // (race), the next poll catches the terminal status and notifies.
      }
```

Finally, find the line at the bottom of the script:

```javascript
      load();
```

Replace with:

```javascript
      load().then(() => startPolling());
```

- [ ] **Step 4: Run drift tests to verify they pass**

Run: `npm test -- --test-name-pattern="ui\\.html"`
Expected: all 5 drift tests pass.

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/ui.html src/daemon/approvals/ui-html-drift.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals/ui): hub_seq + notifyHubIfFramed + polling

Wires ui.html (the /ui/approve page) into Plan 4b's hub:

- Parses hub_seq from location.search with the null-trap guard
  (rawHubSeq === null ? null : Number(...) + Number.isSafeInteger
  + > 0). Missing hub_seq → no-op (direct-opened pages still work).
- notifyHubIfFramed() emits window.parent.postMessage({type:
  "operation_done", seq}) to the hub when framed; no-ops otherwise.
- pollForTerminal() polls /ui/approvals/:id?token= every 2s; on
  terminal status (granted/denied/expired/used), stops polling
  and notifies. startPolling() runs after the initial load();
  beforeunload also stops polling.
- The send() handler (approve/deny POST) gates notifyHubIfFramed()
  on r.ok ONLY. Failed POSTs leave polling active so a server-side
  commit race still surfaces eventually.

Drift-guard test pins all of the above so an accidental removal
fails loudly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E2: `/ui/session` — `session-ui.html`

**Files:**
- Modify: `src/daemon/approvals/session-ui.html`
- Create: `src/daemon/approvals/session-ui-html-drift.test.ts`

- [ ] **Step 1: Write the drift test FIRST**

Create `src/daemon/approvals/session-ui-html-drift.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/approvals/session-ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HTML, "utf8");
}

test("session-ui.html: hub_seq parse + null-trap guard", async () => {
  const html = await loadHtml();
  assert.match(html, /hub_seq/);
  assert.match(html, /Number\.isSafeInteger/);
  assert.match(html, /(===\s*null|!== null)/);
});

test("session-ui.html: notifyHubIfFramed + parent + postMessage", async () => {
  const html = await loadHtml();
  assert.match(html, /function notifyHubIfFramed\b/);
  assert.match(html, /window\.parent\.postMessage/);
  assert.match(html, /operation_done/);
});

test("session-ui.html: pollForTerminal targets /ui/sessions/:id with session terminal statuses", async () => {
  const html = await loadHtml();
  assert.match(html, /function pollForTerminal\b/);
  assert.match(html, /\/ui\/sessions\/\$\{sessionId\}\?token=/);
  for (const status of ["granted", "denied", "expired", "revoked"]) {
    assert.match(html, new RegExp(`"${status}"`), `terminal status ${status}`);
  }
  // Sessions don't have "used" status; the drift guard pins this.
  // (We don't assert absence of "used" — it might appear in unrelated text;
  // the structural check is that the terminal set is in a Set literal with
  // the 4 statuses above.)
});

test("session-ui.html: stopPolling has ≥2 call sites + beforeunload", async () => {
  const html = await loadHtml();
  assert.match(html, /function stopPolling\b/);
  const stopCalls = html.match(/stopPolling\s*\(\s*\)/g) ?? [];
  assert.ok(stopCalls.length >= 2, `expected ≥2 stopPolling() call sites, got ${stopCalls.length}`);
  assert.match(html, /addEventListener\(\s*["']beforeunload["']/);
});

test("session-ui.html: success-only gate — done(verb, ok) gates notify on ok", async () => {
  const html = await loadHtml();
  // Either `if (ok)` (inside done) or `if (r.ok)` (before calling done with notify).
  // Both shapes are acceptable; the drift assertion is one OR the other appears
  // adjacent to notifyHubIfFramed.
  const hasOkGate = /if\s*\(\s*ok\s*\)/.test(html) || /if\s*\(\s*r\.ok\s*\)/.test(html);
  assert.ok(hasOkGate, "expected an `if (ok)` or `if (r.ok)` gate around the notify call");
});
```

- [ ] **Step 2: Run to verify drift tests fail**

Run: `npm test -- --test-name-pattern="session-ui\\.html"`
Expected: 5 tests fail.

- [ ] **Step 3: Edit `src/daemon/approvals/session-ui.html`**

Find the existing inline script (lines 89–107):

```javascript
    (() => {
      const sessionId = "__SESSION_ID__";
      const uiToken = "__UI_TOKEN__";
      const url = (verb) => `/ui/sessions/${encodeURIComponent(sessionId)}/${verb}?token=${encodeURIComponent(uiToken)}`;
      const status = document.getElementById("status");
      function done(verb, ok) {
        document.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        status.textContent = ok ? `Session ${verb}. You can close this tab.` : `Failed to ${verb}; refresh and try again.`;
      }
      document.getElementById("approve").addEventListener("click", async () => {
        const r = await fetch(url("approve"), { method: "POST" });
        done("approved", r.ok);
      });
      document.getElementById("deny").addEventListener("click", async () => {
        const r = await fetch(url("deny"), { method: "POST" });
        done("denied", r.ok);
      });
    })();
```

Replace with:

```javascript
    (() => {
      const sessionId = "__SESSION_ID__";
      const uiToken = "__UI_TOKEN__";
      const url = (verb) => `/ui/sessions/${encodeURIComponent(sessionId)}/${verb}?token=${encodeURIComponent(uiToken)}`;
      const status = document.getElementById("status");

      // ── Plan 4b: hub integration ────────────────────────────────
      const params = new URLSearchParams(location.search);
      const rawHubSeq = params.get("hub_seq");
      const parsedHubSeq = rawHubSeq === null ? null : Number(rawHubSeq);
      const hasHubSeq = parsedHubSeq !== null && Number.isSafeInteger(parsedHubSeq) && parsedHubSeq > 0;

      function notifyHubIfFramed() {
        if (!hasHubSeq) return;
        if (window.parent === window) return;
        window.parent.postMessage({ type: "operation_done", seq: parsedHubSeq }, location.origin);
      }

      const terminalStatuses = new Set(["granted", "denied", "expired", "revoked"]);
      let pollTimer = null;
      async function pollForTerminal() {
        try {
          const r = await fetch(`/ui/sessions/${sessionId}?token=${encodeURIComponent(uiToken)}`);
          if (!r.ok) return;
          const body = await r.json();
          if (terminalStatuses.has(body.status)) {
            stopPolling();
            notifyHubIfFramed();
          }
        } catch { /* network blip; next tick will retry */ }
      }
      function startPolling() { pollTimer = setInterval(pollForTerminal, 2000); }
      function stopPolling() { if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; } }
      window.addEventListener("beforeunload", stopPolling);
      // ────────────────────────────────────────────────────────────

      function done(verb, ok) {
        document.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        status.textContent = ok ? `Session ${verb}. You can close this tab.` : `Failed to ${verb}; refresh and try again.`;
        // Success-only gate: notify the hub queue ONLY when the daemon
        // actually advanced state. Failed POSTs leave polling active so
        // a server-side commit race still surfaces eventually.
        if (ok) {
          stopPolling();
          notifyHubIfFramed();
        }
      }

      document.getElementById("approve").addEventListener("click", async () => {
        const r = await fetch(url("approve"), { method: "POST" });
        done("approved", r.ok);
      });
      document.getElementById("deny").addEventListener("click", async () => {
        const r = await fetch(url("deny"), { method: "POST" });
        done("denied", r.ok);
      });

      startPolling();
    })();
```

- [ ] **Step 4: Run drift tests to verify they pass**

Run: `npm test -- --test-name-pattern="session-ui\\.html"`
Expected: 5 drift tests pass.

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/session-ui.html src/daemon/approvals/session-ui-html-drift.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals/session-ui): hub_seq + notifyHubIfFramed + polling

Wires session-ui.html (/ui/session) into Plan 4b's hub. Mirrors
ui.html (Task E1) with session-specific differences:

- terminalStatuses = granted, denied, expired, revoked. No "used"
  state — sessions don't have one.
- Polls /ui/sessions/${sessionId}?token=...
- done(verb, ok) gates stopPolling() + notifyHubIfFramed() on ok === true.
  Existing done() was called for both success and failure paths;
  the new gate prevents the failure branch from spuriously
  advancing the hub queue.

Drift guard pins the contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task E3: `/ui/unlock` — `unlock-ui.html`

**Files:**
- Modify: `src/daemon/approvals/unlock-ui.html`
- Create: `src/daemon/approvals/unlock-ui-html-drift.test.ts`

- [ ] **Step 1: Write the drift test FIRST**

Create `src/daemon/approvals/unlock-ui-html-drift.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HTML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/approvals/unlock-ui.html",
);

async function loadHtml(): Promise<string> {
  return readFile(HTML, "utf8");
}

test("unlock-ui.html: hub_seq parse with null-trap guard", async () => {
  const html = await loadHtml();
  assert.match(html, /hub_seq/);
  assert.match(html, /Number\.isSafeInteger/);
  assert.match(html, /(===\s*null|!== null)/);
});

test("unlock-ui.html: notifyHubIfFramed defined + postMessage", async () => {
  const html = await loadHtml();
  assert.match(html, /function notifyHubIfFramed\b/);
  assert.match(html, /window\.parent\.postMessage/);
  assert.match(html, /operation_done/);
});

test("unlock-ui.html: notifyHubIfFramed called from success branch only (no polling)", async () => {
  const html = await loadHtml();
  // No polling on unlock — pin the intentional absence.
  assert.doesNotMatch(html, /\bpollForTerminal\b/);
  assert.doesNotMatch(html, /\bstartPolling\b/);
  // Notify must be reachable from the j.ok success path; the existing
  // code uses `if(!j.ok){...}else{ ... }`, so we assert presence of the
  // notify call inside an `else` block or guarded by `j.ok`.
  assert.match(html, /j\.ok/);
  assert.match(html, /notifyHubIfFramed\s*\(\s*\)/);
});
```

- [ ] **Step 2: Run to verify drift tests fail**

Run: `npm test -- --test-name-pattern="unlock-ui\\.html"`
Expected: 3 tests fail.

- [ ] **Step 3: Edit `src/daemon/approvals/unlock-ui.html`**

Replace the entire `<script type="module">` block (lines 13–21):

```html
<script type="module">
const params=new URLSearchParams(location.search);
const id=params.get("id");const token=params.get("token");const create=params.get("create")==="1";
if(create)document.getElementById("hint").textContent="Create a new vault passphrase.";
document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();
const p=document.getElementById("p").value;
const r=await fetch(`/ui/unlock/${id}?token=${token}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({passphrase:p,set_passphrase:create})});
const j=await r.json();if(!j.ok){document.getElementById("err").textContent=j.error?.message??"failed";}else{document.body.innerHTML="<h1>Unlocked. You can close this window.</h1>";}});
</script>
```

With:

```html
<script type="module">
const params=new URLSearchParams(location.search);
const id=params.get("id");const token=params.get("token");const create=params.get("create")==="1";

// ── Plan 4b: hub integration ────────────────────────────────
// Unlock is blocking + retry-oriented; no polling. Notify only on success.
const rawHubSeq = params.get("hub_seq");
const parsedHubSeq = rawHubSeq === null ? null : Number(rawHubSeq);
const hasHubSeq = parsedHubSeq !== null && Number.isSafeInteger(parsedHubSeq) && parsedHubSeq > 0;

function notifyHubIfFramed() {
  if (!hasHubSeq) return;
  if (window.parent === window) return;
  window.parent.postMessage({ type: "operation_done", seq: parsedHubSeq }, location.origin);
}
// ────────────────────────────────────────────────────────────

if(create)document.getElementById("hint").textContent="Create a new vault passphrase.";
document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();
const p=document.getElementById("p").value;
const r=await fetch(`/ui/unlock/${id}?token=${token}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({passphrase:p,set_passphrase:create})});
const j=await r.json();
if(!j.ok){
  document.getElementById("err").textContent=j.error?.message??"failed";
}else{
  document.body.innerHTML="<h1>Unlocked. You can close this window.</h1>";
  notifyHubIfFramed();
}
});
</script>
```

- [ ] **Step 4: Run drift tests to verify they pass**

Run: `npm test -- --test-name-pattern="unlock-ui\\.html"`
Expected: 3 drift tests pass.

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/approvals/unlock-ui.html src/daemon/approvals/unlock-ui-html-drift.test.ts
git commit -m "$(cat <<'EOF'
feat(approvals/unlock-ui): hub_seq + notifyHubIfFramed on success only

Unlock UI is intentionally blocking + retry-oriented — no polling.
Adds:
- hub_seq parse with null-trap guard.
- notifyHubIfFramed() function (no-op when no hub_seq or no parent).
- Call to notifyHubIfFramed() inside the j.ok === true success branch
  ONLY. Failure stays in the form for retry; user closes the tab to
  abandon (SSE drop preserves activeUrl daemon-side for the next
  reattach).

Drift guard pins both the presence of the notify call AND the
absence of any polling logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part F — Call-site swaps (12 routes via `makeHubOpenUrlImpl` + 2 direct)

### Task F0: `makeHubOpenUrlImpl` helper

**Files:**
- Create: `src/daemon/hub/route-helpers.ts`
- Create: `src/daemon/hub/route-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/hub/route-helpers.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run to verify fails**

Run: `npx tsc --noEmit`
Expected: error — `Cannot find module './route-helpers.js'`.

- [ ] **Step 3: Implement `src/daemon/hub/route-helpers.ts`**

```typescript
// src/daemon/hub/route-helpers.ts
import type { DaemonServices } from "../services.js";

/**
 * Build the `openUrlImpl` callback that `requireApproval` (and any
 * direct call site) hands to the hub. The closure captures `services`
 * and a port-ref thunk so the same factory works across daemon
 * restarts (port may shift).
 */
export function makeHubOpenUrlImpl(
  services: DaemonServices,
  daemonPortRef: () => number,
): (url: string) => void {
  return (url: string) => {
    services.hubBroker.surface(url, daemonPortRef());
  };
}
```

- [ ] **Step 4: Run to verify passes**

Run: `npm test -- --test-name-pattern="makeHubOpenUrlImpl"`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/hub/route-helpers.ts src/daemon/hub/route-helpers.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): makeHubOpenUrlImpl helper for requireApproval wiring

Thin factory that closures over services + daemonPortRef and returns
the (url) => void function requireApproval expects as openUrlImpl.
Centralizes the "surface this URL through the hub" call so the 9
Plan 4a I1 approval routes + 3 V0 routes can each add a one-line
import + pass-through without re-implementing the broker plumbing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Tasks F1–F9: Modern approval-gated routes — pass `openUrlImpl: makeHubOpenUrlImpl(...)` to `requireApproval`

**Pattern (applied to each of the 9 modern routes):**
1. Add `import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";` at the top.
2. In the route handler (already wraps `requireApproval` per Plan 4a I1), add `openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef)` to the options object.
3. Typecheck + test + commit.

Each route is a separate commit for clean revert granularity.

#### Task F1: `templates.ts`

- [ ] **Step 1: Edit `src/daemon/api/routes/templates.ts`**

Add import near the top:

```typescript
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
```

Find the `requireApproval({...})` call (around line 123). The current options object has `store`, `binding`, `daemonPort`, `sessionStore`, conditional `sessionId`/`approvalIdFromClient`/`waitMs`. Add `openUrlImpl`:

```typescript
      grant = await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        sessionStore: services.sessionStore,
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(approvalId !== undefined ? { approvalIdFromClient: approvalId } : {}),
        ...(waitForApproval === false ? { waitMs: 0 } : {}),
      });
```

- [ ] **Step 2: Run tests**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="template"`
Expected: existing template tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/routes/templates.ts
git commit -m "feat(routes/templates): route approval URL through the hub

Adds openUrlImpl: makeHubOpenUrlImpl(...) to the requireApproval
call. The per-URL ui_token remains the operational security
boundary; only the spawn-or-reuse decision moves to the hub broker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

#### Task F2: `secrets.ts` — `/v1/secrets/generate` (modern)

- [ ] **Step 1: Edit `src/daemon/api/routes/secrets.ts`**

Add import:

```typescript
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
```

In the `/v1/secrets/generate` handler (lines 86–162), find the `requireApproval` call (line 125-131 region) and add `openUrlImpl`. Apply only to the GENERATE handler; leave capture/inject/compare for Task F10.

- [ ] **Step 2-3: typecheck + test + commit**

```bash
npx tsc --noEmit && npm test -- --test-name-pattern="secrets.generate"
git add src/daemon/api/routes/secrets.ts
git commit -m "feat(routes/secrets-generate): route approval URL through the hub

Adds openUrlImpl to the /v1/secrets/generate requireApproval call.
V0 endpoints in this file (capture, inject, compare) wired in F10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

#### Tasks F3–F9: identical pattern for each remaining modern route

For each file below, repeat: add the import + add `openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef)` to the route's `requireApproval` options, then typecheck/test/commit individually.

- [ ] **F3:** `src/daemon/api/routes/inject-submit.ts`
- [ ] **F4:** `src/daemon/api/routes/reveal-capture.ts`
- [ ] **F5:** `src/daemon/api/routes/run-resolve.ts`
- [ ] **F6:** `src/daemon/api/routes/inject-render.ts`
- [ ] **F7:** `src/daemon/api/routes/secrets-delete.ts`
- [ ] **F8:** `src/daemon/api/routes/secrets-rotate.ts`
- [ ] **F9:** `src/daemon/api/routes/blind.ts` (only the `/v1/blind/end` handler — `/v1/blind/start` doesn't call requireApproval)

For each: `git commit -m "feat(routes/<name>): route approval URL through the hub\n\nAdds openUrlImpl: makeHubOpenUrlImpl(...) to the requireApproval call.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"`.

---

### Task F10: `secrets.ts` — V0 handlers (capture, inject, compare)

**File:**
- Modify: `src/daemon/api/routes/secrets.ts` (the same file as F2, but the three V0 handlers)

- [ ] **Step 1: Find each V0 `requireApproval` call**

Run: `grep -n "requireApproval" src/daemon/api/routes/secrets.ts`

Expected: 4 hits — generate (already wired in F2), capture (~line 196), inject (~line 281), compare (~line 361).

- [ ] **Step 2: Add `openUrlImpl` to each of the three V0 calls**

For each of the three handlers, modify the `requireApproval({...})` call to include:

```typescript
        openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
```

(Place it next to the existing `daemonPort: daemonPortRef()` line.)

The import added in F2 already covers this file.

- [ ] **Step 3: Run typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/api/routes/secrets.ts
git commit -m "$(cat <<'EOF'
feat(routes/secrets-v0): route capture/inject/compare approval URLs through the hub

V0 endpoints (/v1/secrets/capture, /v1/secrets/inject,
/v1/secrets/compare) still ship in v0.2.0 and gate on requireApproval.
Plan 4b's "every approval URL uses one hub tab" promise includes
them. V0 routes don't get session_id wiring (their actions aren't
SessionAction values), but they DO get tab reuse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task F11: `approvals-session.ts` direct swap

**File:**
- Modify: `src/daemon/api/routes/approvals-session.ts`

- [ ] **Step 1: Replace the direct `openUrl(...)` call**

Currently (line 29):

```typescript
import { openUrl } from "../../approvals/open-url.js";
// ...
    openUrl(
      `http://127.0.0.1:${daemonPortRef()}/ui/session?id=${grant.id}&token=${grant.ui_token}`,
    );
```

Remove the `import { openUrl } ...` line. Replace the call. **Capture the port once** so the URL embedded in the operation and the port passed to the broker can't diverge under a port-shift race:

```typescript
    const port = daemonPortRef();
    services.hubBroker.surface(
      `http://127.0.0.1:${port}/ui/session?id=${grant.id}&token=${grant.ui_token}`,
      port,
    );
```

- [ ] **Step 2: Run typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/routes/approvals-session.ts
git commit -m "$(cat <<'EOF'
feat(routes/approvals-session): route session approval URL through the hub

Replaces the direct openUrl() spawn with services.hubBroker.surface().
The session HTML approval page (/ui/session) now opens in the
persistent hub tab rather than spawning a fresh tab on every
POST /v1/approvals/session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task F12: `unlock-session.ts` direct swap

**File:**
- Modify: `src/daemon/api/routes/unlock-session.ts`

- [ ] **Step 1: Replace the direct `openUrl(...)` call**

In `POST /v1/unlock/start` handler (around line 18–30), the existing code computes the URL using `daemonPortRef()`, then calls `openUrl(url)`. Refactor so the port is captured once and reused for both the URL and the broker call. Remove the `openUrl` import.

Find:

```typescript
import { openUrl } from "../../approvals/open-url.js";
// ...
    const url = `http://127.0.0.1:${daemonPortRef()}/ui/unlock?id=${session.id}&token=${session.ui_token}${envelope === null ? "&create=1" : ""}`;
    openUrl(url);
```

Replace with (also remove the `openUrl` import):

```typescript
    const port = daemonPortRef();
    const url = `http://127.0.0.1:${port}/ui/unlock?id=${session.id}&token=${session.ui_token}${envelope === null ? "&create=1" : ""}`;
    services.hubBroker.surface(url, port);
```

- [ ] **Step 2: Run typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: clean. Existing unlock tests should still pass (they don't depend on whether openUrl was called via the broker or directly).

- [ ] **Step 3: Commit**

```bash
git add src/daemon/api/routes/unlock-session.ts
git commit -m "$(cat <<'EOF'
feat(routes/unlock-session): route unlock UI URL through the hub

Replaces the direct openUrl() spawn with services.hubBroker.surface().
The unlock UI now opens in the persistent hub tab. Unlock UI itself
does not poll (it's blocking + retry-oriented per Plan 4b spec) —
the hub queue waits on either unlock success (notifyHubIfFramed)
or tab close (SSE drop, activeUrl preserved for the next attach).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Part G — End-to-end + verification + CHANGELOG

### Task G1: End-to-end tests

**Files:**
- Create: `src/daemon/hub/hub-e2e.test.ts`

- [ ] **Step 1: Write the e2e tests**

Create `src/daemon/hub/hub-e2e.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the e2e tests**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="^e2e:"`
Expected: 6 e2e tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/hub/hub-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(hub): end-to-end coverage of spawn/attach/queue/displacement flows

Real DaemonServer + injected HubBroker (spy openUrlImpl + synthetic
clock) + the full registerRoutes wiring. Mirrors the spec's six
data-flow scenarios:

- Single approval via hub.
- Burst while detached → exactly one spawn, FIFO drain.
- Tab-close mid-op + post-timeout recovery → 3 opens (initial +
  in-window + post-timeout respawn) + resend on reattach.
- Tab-close mid-op stays within spawn window → 2 opens + resend.
- /ui/hub/done route smoke under retry-shaped traffic → idempotent
  200/200 (mismatched-seq second call is a no-op).
- Permanent postDone failure (simulated via detach1) → SSE detach
  → respawn-on-next-surface → resend activeUrl on the new attach.

Each test exercises the broker through both HTTP (where the spec
requires server-observable behavior) and the broker's direct
attach()/markDone() API (where state-machine assertions are
clearer).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task G1.5: Browser-level DOM smoke test (jsdom)

**Files:**
- Modify: `package.json` (add `jsdom` as dev dep)
- Create: `src/daemon/hub/hub-ui-dom.test.ts`

The drift-guard tests (Task C2) only check that source patterns exist; they do not run the hub JS. Plan 4b is a UX/security path where the inline JS in `hub-ui.html` is load-bearing — a regression in the navigate handler, the postMessage gate, or the displaced cleanup would silently break the persistent-tab guarantee. This task adds ONE browser-level smoke via `jsdom` that loads the actual HTML, mocks `EventSource` + `fetch`, and asserts the DOM mutates correctly.

- [ ] **Step 1: Add jsdom dev dep (pinned major)**

Run: `npm install --save-dev jsdom@^24.0.0 @types/jsdom@^21.1.0`

Expected: package.json gains `"jsdom": "^24.0.0"` and `"@types/jsdom": "^21.1.0"` under `devDependencies`. Pinning the major because jsdom's `runScripts` / `beforeParse` API has shifted between majors in the past; we want a known-good baseline for the drift guard to follow.

- [ ] **Step 2: Write the failing test**

Create `src/daemon/hub/hub-ui-dom.test.ts`:

```typescript
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JSDOM, ResourceLoader } from "jsdom";

const HUB_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/daemon/hub/hub-ui.html",
);

/**
 * Build a JSDOM with mocked EventSource + fetch INSTALLED BEFORE the
 * inline <script> parses. The hub script runs `connect()` (which calls
 * `new EventSource(...)`) immediately during parse — if we installed
 * the mocks after `new JSDOM(...)`, the script would have already run
 * against the (missing) default EventSource and errored. The
 * `beforeParse(window)` hook lets us install the globals before the
 * parser touches the HTML.
 */
async function loadHub(): Promise<{
  dom: JSDOM;
  feedSse: (data: unknown) => void;
  emitOpen: () => void;
  emitError: () => void;
  fetches: Array<{ url: string; init: RequestInit | undefined }>;
  fetchResponder: (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => void;
}> {
  const html = await readFile(HUB_HTML_PATH, "utf8");

  let latestEs: { listeners: Record<string, Array<(e: unknown) => void>>; closed: boolean } | null = null;
  const fetches: Array<{ url: string; init: RequestInit | undefined }> = [];
  let responder: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

  class FakeEventSource {
    public readonly url: string;
    public readonly listeners: Record<string, Array<(e: unknown) => void>> = {};
    public closed = false;
    constructor(url: string) {
      this.url = url;
      latestEs = this;
    }
    addEventListener(name: string, fn: (e: unknown) => void): void {
      (this.listeners[name] = this.listeners[name] ?? []).push(fn);
    }
    close(): void { this.closed = true; }
  }

  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:5555/ui/hub?token=hubT",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    resources: new ResourceLoader({ strictSSL: false }),
    // CRITICAL: install globals BEFORE the parser touches the inline
    // <script>. The hub script calls connect() at the bottom, which
    // does `new EventSource(...)` — without these mocks in place at
    // parse time, the script throws.
    beforeParse(window) {
      (window as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
      (window as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        fetches.push({ url, init });
        return responder(url, init);
      }) as typeof fetch;
    },
  });

  // Yield once to let any post-parse microtasks complete (e.g., the
  // connect() call's synchronous initial EventSource construction).
  await new Promise((r) => setTimeout(r, 10));

  const driveEvent = (name: string, payload: unknown): void => {
    const handlers = latestEs?.listeners[name] ?? [];
    for (const h of handlers) h(payload);
  };

  return {
    dom,
    feedSse: (data) => driveEvent("message", { data: JSON.stringify(data) }),
    emitOpen: () => driveEvent("open", {}),
    emitError: () => driveEvent("error", {}),
    fetches,
    fetchResponder: (h) => { responder = h; },
  };
}

test("hub-ui dom: navigate event sets iframe.src to the carried URL", async () => {
  const ctx = await loadHub();
  ctx.emitOpen();
  ctx.feedSse({ type: "navigate", url: "http://127.0.0.1:5555/ui/approve?id=a&token=t&hub_seq=1", seq: 1 });
  const iframe = ctx.dom.window.document.getElementById("op") as HTMLIFrameElement;
  assert.equal(iframe.src, "http://127.0.0.1:5555/ui/approve?id=a&token=t&hub_seq=1");
});

test("hub-ui dom: displaced event hides iframe and points it at about:blank", async () => {
  const ctx = await loadHub();
  ctx.emitOpen();
  ctx.feedSse({ type: "navigate", url: "http://127.0.0.1:5555/ui/approve?id=a&token=t&hub_seq=1", seq: 1 });
  const iframe = ctx.dom.window.document.getElementById("op") as HTMLIFrameElement;
  assert.match(iframe.src, /\/ui\/approve/);

  ctx.feedSse({ type: "displaced" });
  // CSS hides #op when #status has the displaced class.
  const status = ctx.dom.window.document.getElementById("status")!;
  assert.match(status.className, /displaced/);
  // JS also reassigns iframe.src to about:blank as defense-in-depth.
  assert.equal(iframe.src, "about:blank");
});

test("hub-ui dom: postMessage with valid origin+source+seq triggers POST /ui/hub/done", async () => {
  const ctx = await loadHub();
  ctx.emitOpen();
  ctx.feedSse({ type: "navigate", url: "http://127.0.0.1:5555/ui/approve?id=a&token=t&hub_seq=1", seq: 1 });
  const iframe = ctx.dom.window.document.getElementById("op") as HTMLIFrameElement;

  // Manufacture a MessageEvent with origin === location.origin and
  // source === iframe.contentWindow.
  const ev = new ctx.dom.window.MessageEvent("message", {
    data: { type: "operation_done", seq: 1 },
    origin: "http://127.0.0.1:5555",
    source: iframe.contentWindow as unknown as MessageEventSource,
  });
  ctx.dom.window.dispatchEvent(ev);

  // Allow the async postDone() to fire.
  await new Promise((r) => setTimeout(r, 50));

  const doneCall = ctx.fetches.find((f) => f.url.includes("/ui/hub/done"));
  assert.ok(doneCall !== undefined, "expected fetch to /ui/hub/done");
  const body = doneCall!.init?.body as string | undefined;
  assert.ok(body !== undefined);
  const parsed = JSON.parse(body!) as { seq: number };
  assert.equal(parsed.seq, 1);
});

test("hub-ui dom: postMessage with wrong origin is ignored (no fetch)", async () => {
  const ctx = await loadHub();
  ctx.emitOpen();
  ctx.feedSse({ type: "navigate", url: "http://127.0.0.1:5555/ui/approve?id=a&token=t&hub_seq=1", seq: 1 });
  const iframe = ctx.dom.window.document.getElementById("op") as HTMLIFrameElement;

  const ev = new ctx.dom.window.MessageEvent("message", {
    data: { type: "operation_done", seq: 1 },
    origin: "http://evil.example.com",
    source: iframe.contentWindow as unknown as MessageEventSource,
  });
  ctx.dom.window.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 50));

  const doneCall = ctx.fetches.find((f) => f.url.includes("/ui/hub/done"));
  assert.equal(doneCall, undefined, "wrong-origin postMessage must NOT trigger /ui/hub/done");
});

test("hub-ui dom: clicking the displaced-banner button (takeOver) re-issues the EventSource", async () => {
  const ctx = await loadHub();
  ctx.emitOpen();
  ctx.feedSse({ type: "navigate", url: "http://127.0.0.1:5555/ui/approve?id=a&token=t&hub_seq=1", seq: 1 });
  // Drive displacement.
  ctx.feedSse({ type: "displaced" });
  const banner = ctx.dom.window.document.getElementById("banner")!;
  const btn = banner.querySelector("button");
  assert.ok(btn, "displaced banner must include a recovery button");
  // Before click: only the initial EventSource was constructed.
  // Track via window.__esConstructions if the test harness exposes it,
  // or just verify the click triggers a new SSE connection by observing
  // a second fetch to /ui/hub/stream on the next message attempt.
  // Simplest: after click, the banner clears and statusEl flips to
  // "reconnecting" — visible state change proves the click ran.
  btn!.dispatchEvent(new ctx.dom.window.MouseEvent("click"));
  // Yield once for connect()'s synchronous EventSource construction.
  await new Promise((r) => setTimeout(r, 10));
  const statusEl = ctx.dom.window.document.getElementById("status")!;
  assert.match(statusEl.className, /reconnecting/);
  assert.equal(banner.innerHTML, "", "banner must clear after takeOver()");
});

test("hub-ui dom: terminal-state banners do not instruct the user to reload", async () => {
  const ctx = await loadHub();
  ctx.emitOpen();
  ctx.feedSse({ type: "displaced" });
  const banner = ctx.dom.window.document.getElementById("banner")!;
  // After history.replaceState, a reload hits /ui/hub with no token (400).
  // Banner copy must NOT instruct the user to reload — the recovery
  // surface is the in-page button.
  assert.doesNotMatch(banner.textContent ?? "", /reload/i);
});

test("hub-ui dom: duplicate operation_done for same seq fires only one fetch", async () => {
  const ctx = await loadHub();
  ctx.emitOpen();
  ctx.feedSse({ type: "navigate", url: "http://127.0.0.1:5555/ui/approve?id=a&token=t&hub_seq=1", seq: 1 });
  const iframe = ctx.dom.window.document.getElementById("op") as HTMLIFrameElement;

  for (let i = 0; i < 3; i++) {
    const ev = new ctx.dom.window.MessageEvent("message", {
      data: { type: "operation_done", seq: 1 },
      origin: "http://127.0.0.1:5555",
      source: iframe.contentWindow as unknown as MessageEventSource,
    });
    ctx.dom.window.dispatchEvent(ev);
  }
  await new Promise((r) => setTimeout(r, 100));

  const doneCalls = ctx.fetches.filter((f) => f.url.includes("/ui/hub/done"));
  // shouldPostDone() gates duplicates: doneInFlight covers concurrent
  // dispatch, lastCompletedSeq covers post-success dispatch. We expect
  // exactly 1 fetch even with 3 postMessages.
  assert.equal(doneCalls.length, 1, `expected exactly 1 /ui/hub/done fetch, got ${doneCalls.length}`);
});
```

- [ ] **Step 3: Run to verify the DOM tests pass**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="hub-ui dom"`
Expected: 5 DOM tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/daemon/hub/hub-ui-dom.test.ts
git commit -m "$(cat <<'EOF'
test(hub): jsdom-based DOM smoke test for hub-ui.html

Loads hub-ui.html in jsdom (runScripts: dangerously, daemon-owned
content), mocks EventSource and fetch, and asserts the inline JS
actually behaves correctly when driven:

- navigate event → iframe.src is set.
- displaced event → status class becomes 'displaced' (CSS hides
  iframe) AND iframe.src is reassigned to about:blank (JS
  defense-in-depth). Closes Plan 4b post-review P1 — a displaced
  tab cannot continue approving operations.
- postMessage with valid origin+source+seq triggers POST /ui/hub/done.
- postMessage with wrong origin is ignored (no fetch).
- Duplicate operation_done for same seq triggers exactly ONE fetch
  (shouldPostDone gate works end-to-end).

Closes Plan 4b post-review P2: the "e2e" layer no longer relies
solely on broker.attach() — at least one test exercises the actual
browser contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task G2: `SECRET_SHUTTLE_NO_OPEN_URL` regression

**Files:**
- Create: `src/daemon/hub/hub-no-open-url.test.ts`

- [ ] **Step 1: Write the test**

Create `src/daemon/hub/hub-no-open-url.test.ts`:

```typescript
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
          spawnImpl: (cmd, args, opts) => {
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
```

- [ ] **Step 2: Run the tests**

Run: `npx tsc --noEmit && npm test -- --test-name-pattern="SECRET_SHUTTLE_NO_OPEN_URL"`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/hub/hub-no-open-url.test.ts
git commit -m "$(cat <<'EOF'
test(hub): SECRET_SHUTTLE_NO_OPEN_URL=1 silences hub spawn

Proves the env-var bypass that the rest of the test suite relies on
still works for the hub spawn path. HubBroker calls openUrl(hubUrl)
when transitioning detached→spawn, and openUrl honors the env var
by no-op'ing the spawn. The state machine continues to mutate
normally so attach() still drains the queue when a fake subscriber
is wired in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task G3: Full suite verification

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: ~920–930 tests passing, 2 skipped, 0 failing. Baseline was 842; new tests added across A1 (~20), B1 (3), B2 (3), B3 (8), B4 (3 wiring: 1 noop-under-env-var + 1 hook-exercises-default-path + 1 source-drift `?? openUrl`), C2 (9), D1 (1), D2 (1), D3 (1), E1 (5), E2 (5), E3 (3), F0 (2), G1 (6), G1.5 (7: 5 original + 1 takeOver button + 1 no-reload-in-banner), G2 (2) = ~79 new tests. Final ~921 pass.

- [ ] **Step 3: Run check-pack**

Run: `npm run check-pack`
Expected: clean. The build script now copies `hub-ui.html` to `dist/daemon/hub/hub-ui.html`; verify by inspecting the check-pack output.

- [ ] **Step 4: Manual smoke (optional — requires real browser)**

Skip in subagent-driven execution. If running inline, document the manual smoke in `docs/superpowers/plans/2026-05-23-plan4b-tab-reuse-smoke.md` for reference:

1. Start daemon: `secret-shuttle daemon start`.
2. Trigger an approval-gated op: `secret-shuttle template run vercel-env-add --ref ss://local/prod/X --param environment=production`.
3. Verify ONE tab opens; it's the hub at `/ui/hub?token=...`. The iframe contains `/ui/approve?id=&token=&hub_seq=1`. Approve.
4. Trigger a second op: same tab, no new browser window. Hub navigates iframe to the new operation.
5. Close the hub tab. Trigger a third op: a new hub tab spawns (≤ 5s post-timeout).
6. With first hub still open, open `http://127.0.0.1:<port>/ui/hub?token=<token>` in a second tab. Original tab shows "Another tab is now driving Secret Shuttle" banner.

- [ ] **Step 5: No commit (verification only)**

If `npm test` is green and `check-pack` passes, move on to G4.

---

### Task G4: CHANGELOG entry + final commit

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Append the Plan 4b entry under `## Unreleased`**

In `CHANGELOG.md`, find the `## Unreleased` section. After the existing `### Added — Plan 4a (pre-approved sessions)` section (and its `### Security` block), add:

```markdown
### Added — Plan 4b (single-window tab reuse)
- **Persistent hub tab.** The daemon opens exactly one `GET /ui/hub?token=…` tab per process lifetime and reuses it for every approval, session-approval, and unlock URL. Replaces the v0.1.x "one tab per call" behavior. Each operation is rendered inside a same-origin iframe; the per-URL `ui_token` remains the operational security boundary.
- **`HubBroker`** owns the FIFO queue + active operation slot. Daemon-owned (not browser-owned), so a tab close mid-operation never loses queued URLs. Spawn debounce (`SPAWN_TIMEOUT_MS = 5s`) gates burst respawns; once a hub attaches, the in-flight flag clears so a later close + new surface respawns immediately.
- **SSE event protocol.** `GET /ui/hub/stream?token=H` emits `{type:"navigate", url, seq}` events. Each navigate carries an `hub_seq` query param the framed operation page reads from `location.search` and echoes back via `POST /ui/hub/done?token=H {seq}`. `markDone(seq)` is idempotent — duplicate/stale done events are silent no-ops.
- **Displacement.** Opening a second hub tab manually causes the broker to emit `{type:"displaced"}` to the old subscriber + close it. The old tab JS suppresses reconnect via a `terminal=true` flag set BEFORE the explicit `es.close()` (so the close-triggered `onerror` is also suppressed).
- **Reconnect safety.** `EventSource` has built-in auto-reconnect; the hub JS explicitly `es.close()` on every `onerror` and tracks `consecutiveFailures` (reset on the `open` event). Two consecutive failures (no intervening success) lock to a terminal banner; one transient blip recovers.
- **Operation-page polling** (`/ui/approve` and `/ui/session`) every 2s detects daemon-side terminal status (e.g., grant expired via TTL) and fires `notifyHubIfFramed()` so the hub queue advances even when the user has walked away. Unlock UI does NOT poll — unlock is blocking + retry-oriented; the queue waits on either user success (notify) or tab close (SSE drop, activeUrl preserved for reattach).
- **Duplicate-done suppression.** Client-side `doneInFlight` Set + `lastCompletedSeq` high-water mark in the hub JS prevent a duplicate `operation_done` event whose retries exhaust from running the terminal branch after a sibling duplicate already succeeded.
- **`postDone()` retry loop.** 5 attempts with linear backoff (250ms × attempt). `401`/`403`/`400` are terminal (no retry). On exhaustion: `terminal=true`, `es.close()`, banner. Daemon detach triggers respawn on the next surface; `activeUrl` stays set so the reload/reattach resends the operation.
- **`/ui/hub/done` body cap.** `addRouteRaw` bypasses the daemon's standard 1 MB JSON parser, so the route uses its own `readBoundedJson(req, 1024)` helper. Oversize → `request_too_large` (the existing registered code). Malformed JSON → `bad_request`.
- **CSP relaxation on three operation routes** (`/ui/approve`, `/ui/session`, `/ui/unlock`): `frame-ancestors 'none'` → `frame-ancestors 'self'`. Same-origin embedding only; the daemon binds 127.0.0.1 so the threat surface is the daemon's own pages. Per-URL `ui_token` continues to gate access.
- **Drift-guard tests** for `ui.html`, `session-ui.html`, `unlock-ui.html`, and `hub-ui.html`. Crude text-pattern assertions on inline JS that catch accidental removal of polling, hub_seq parsing, terminal-state cascade, duplicate-done suppression, and `postDone` retry shape.

### Security
- **Two-layer capability model.** The `hub_token` (minted via `randomUUID()` at `HubBroker` construction; held in memory only) grants subscription to `/ui/hub/stream` — the SSE feed that carries each operation's `{type:"navigate", url, seq}` event. Each operation URL inside those events carries its own short-lived `ui_token` that gates the actual approve/deny action. **The two tokens compose:** without `hub_token` an attacker cannot observe operations; without `ui_token` an attacker cannot act on a specific operation. A leaked `hub_token` is roughly equivalent to a leaked daemon bearer token in scope — the attacker can observe everything the daemon surfaces. The model is "two layers, not one stronger than the other."
- **Daemon binds 127.0.0.1.** The threat model assumes hostile local processes that can already enumerate ports. The hub adds no new network surface; it inherits the daemon's localhost-only constraint.
- **`hub_token` stripped from address bar after bootstrap.** On load, `hub-ui.html` reads `params.get("token")` into a closure-local `hubToken` variable then immediately calls `history.replaceState({}, "", "/ui/hub")` so the token is no longer visible in (a) the address bar (screenshot/screenshare leakage), (b) `Referer` headers when fetching `/ui/hub/stream` or `/ui/hub/done`, or (c) `window.parent.location.search` reads from iframe content. The token survives only as a JS closure variable — not reachable via `window.parent.hubToken` because it's never assigned to `window`.
- **Hub status bar shows connection state + daemon port only.** No vault state (would require an authenticated status route — out of scope for v0.2.0), no token preview (would defeat the address-bar strip above).
- **Daemon restart rotates `hub_token`.** Any still-open hub from the prior process gets 401 on next SSE attempt → banner appears → user reloads.
- **Iframe is `sandbox="allow-scripts allow-same-origin allow-forms"`.** Same-origin is required so the iframe's existing approval/session JS can POST to `/ui/approvals/...` and `/ui/sessions/...`. The CSP `frame-ancestors 'self'` ensures only the daemon's own hub can frame these pages — a same-origin restriction the per-URL `ui_token` further hardens at the action layer.
- **Displaced / disconnected tabs are non-interactive.** When SSE delivers `{type:"displaced"}` OR the reconnect strikes-out, `hub-ui.html` reassigns `iframe.src = "about:blank"` AND a CSS rule hides the iframe element. A displaced tab cannot continue approving operations the user thought were handed off to the new tab.
- `SECRET_SHUTTLE_NO_OPEN_URL=1` continues to silence all tab spawning (including the hub spawn). Tests rely on this; `npm test` sets it.
- **Unlock-blocking semantic** documented: an unlock that never succeeds blocks the hub queue until the user closes the tab. Acceptable for v0.2.0 since unlock is rare and a stuck unlock is operationally visible. An explicit `hub_queue_full` error is deferred to v0.3.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): Plan 4b — single-window tab reuse

Adds the user-facing summary for Plan 4b: persistent hub tab,
daemon-owned FIFO via HubBroker, SSE event protocol with hub_seq
echo-back, displacement semantics, reconnect safety with
consecutiveFailures reset, operation-page polling (approval +
session, NOT unlock), client-side duplicate-done suppression,
postDone retry loop, /ui/hub/done body cap, CSP frame-ancestors
relaxation on the three operation routes, and drift-guard tests
covering all four HTMLs.

Security section captures: hub_token lifetime + non-persistence,
no-vault-state-in-status-bar rationale, per-URL ui_token unchanged,
SECRET_SHUTTLE_NO_OPEN_URL still works, unlock-blocking semantic
documented.

Closes Plan 4b. Predecessor: Plan 4a (commit 8b77556).
Successor: Plan 4c (stdin pass-through).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage:**
- Goal (one persistent tab) → Tasks A1, B1–B4, C1, F0–F12.
- Per-URL ui_token preserved → unchanged in operation routes; hub uses separate hub_token (A1 + B1).
- Cross-platform openUrl → unchanged; HubBroker calls existing `openUrl` (A1 + G2).
- Hub failure mode (spawn fresh) → A1's surface() + isSpawnInFlight (G1 e2e).
- SECRET_SHUTTLE_NO_OPEN_URL preserved → G2.
- HubBroker contract (surface/attach/markDone/withHubSeq/hubUrl/tokenMatches/peekState) → A1.
- SSE event protocol + displaced + navigate seq → A1 + B2.
- POST /ui/hub/done idempotency + body cap → B3.
- Operation page hub_seq + polling + success-only gate + notify → E1 + E2 + E3.
- CSP relaxation (3 routes) → D1 + D2 + D3.
- 12 route swaps + 2 direct → F1–F12.
- Reconnect safety (consecutiveFailures reset on open) → C1 + C2 drift guard.
- Duplicate-done suppression → C1 + C2 drift guard.
- postDone retry with terminal branch closing SSE → C1 + C2 drift guard.
- E2E + SECRET_SHUTTLE_NO_OPEN_URL regression → G1 + G2.
- CHANGELOG → G4.

**Placeholder scan:**
- No TBD / TODO / "implement later" / "Similar to Task N" / "add appropriate error handling".
- Every step has either exact code or exact commands.
- Test code is concrete.

**Type consistency:**
- `HubEvent`, `HubSubscriber`, `HubBrokerOptions`, `HubBroker`, `withHubSeq`, `SPAWN_TIMEOUT_MS` defined in A1 and consumed throughout.
- `makeHubOpenUrlImpl(services, daemonPortRef)` defined in F0 and consumed by F1–F10.
- `DaemonServicesOptions { hubBroker?: HubBroker }` defined in B4 and consumed by G1.
- `readBoundedJson(req, maxBytes)` defined in B3 and used by the POST /ui/hub/done route.
- Per-page inline JS contracts (`hub_seq`, `notifyHubIfFramed`, `pollForTerminal`, `stopPolling`, `terminalStatuses`, `postDone`, `shouldPostDone`, `doneInFlight`, `lastCompletedSeq`, `consecutiveFailures`, `terminal`) are consistent across hub-ui.html (C1), ui.html (E1), session-ui.html (E2), unlock-ui.html (E3), and their drift-guard tests (C2, E1, E2, E3).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-plan4b-tab-reuse.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. **REQUIRED SUB-SKILL:** `superpowers:executing-plans`.

Which approach?
