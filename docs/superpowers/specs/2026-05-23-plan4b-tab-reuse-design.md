# Plan 4b — Single-Window Tab Reuse (Design)

**Status:** approved through Section 5; pending user spec review before writing-plans.
**Author:** Patryk + Claude (brainstorming session 2026-05-23)
**Predecessor:** Plan 4a (sessions) — completed at commit `8b77556`. Test baseline 842/840/2/0.
**Successor:** Plan 4c (stdin pass-through), then Plan 5a (init + native keychain).

---

## Goal

One persistent browser tab serves every approval, unlock, and session-approval URL the daemon emits for its entire process lifetime. Replaces the current behavior where each `openUrl(url)` call spawns a fresh tab — documented in `src/daemon/approvals/open-url.ts:25-27` as the accepted v0.1.x trade-off.

## Non-goals

- Stdin pass-through (Plan 4c).
- Native keychain (Plan 5a).
- Nonce-based CSP that drops `'unsafe-inline'` (deferred — see "CSP relaxation" below).
- Server-side rendering of operation pages (kept static; client-side query-string parsing carries the new `hub_seq` param).

## Constraints carried from the brief

- Preserve the per-URL `ui_token` security property — each operation is still gated by its own token.
- Survive macOS / Linux / Windows differences in how `openUrl` chooses a browser (no change to that helper).
- Degrade gracefully when the daemon can't reach the existing tab (browser closed, profile killed).
- Preserve `SECRET_SHUTTLE_NO_OPEN_URL=1` as a complete no-op for tests.

---

## Architecture

A persistent **hub page** (one tab) acts as a thin shell that:
- Authenticates to the daemon via a long-lived `hub_token` minted at HubBroker construction.
- Maintains an `EventSource` to `/ui/hub/stream` for daemon→hub events.
- Renders the current operation in a same-origin `<iframe>` whose `src` is updated by navigate events.
- Signals operation completion back to the daemon via `POST /ui/hub/done`.

A daemon-side **HubBroker** owns the FIFO queue of pending operation URLs. The broker spawns the hub tab on first surface (or on respawn when the hub has closed and a new operation arrives), drains queued URLs to the attached subscriber, and advances the queue on done signals.

The existing per-URL `ui_token` on each operation page remains the operational security boundary. The new `hub_token` authenticates only the hub shell; it does not grant access to any operation.

---

## Components

### 1. `src/daemon/hub/hub-broker.ts`

Pure state machine. No I/O except via the injected `openUrlImpl`.

```ts
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
  openUrlImpl?: (url: string) => void;
  now?: () => number;
}

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

  constructor(opts?: HubBrokerOptions);

  /** Daemon-lifetime auth token for /ui/hub*, never written to disk. */
  hubToken(): string;

  /** Constant-time compare for routes. */
  tokenMatches(supplied: string): boolean;

  /** Absolute URL for the platform openUrl call. */
  hubUrl(port: number): string;

  /**
   * Push a new operation URL into the hub flow.
   * - Attached + idle: set active + write navigate.
   * - Attached + busy: enqueue.
   * - Detached: enqueue; spawn hub iff !isSpawnInFlight().
   */
  surface(operationUrl: string, port: number): void;

  /**
   * Attach a new subscriber. Displaces any prior subscriber.
   * Resends the active operation (recovery path) OR promotes the
   * front of the queue (cold-start drain path).
   * Returns a detach callback that nulls currentSubscriber iff it
   * still equals this subscriber.
   */
  attach(sub: HubSubscriber): () => void;

  /**
   * Called by POST /ui/hub/done. If seq matches the current active,
   * clear active and promote the next queued URL. Otherwise no-op
   * (idempotent: stale or duplicate done events ignored).
   */
  markDone(seq: number): void;

  // ─── Internals exposed for tests ──────────────────────────
  /** @internal */ peekState(): {
    queueLength: number; activeUrl: string | null; activeSeq: number | null;
    isAttached: boolean; spawnInFlight: boolean;
  };
}
```

**`surface(url, port)` rules.**
1. If `currentSubscriber !== null && activeUrl === null`: `activeUrl = url`, `activeSeq = nextSeq++`, write `{type:"navigate", url: withHubSeq(url, activeSeq), seq: activeSeq}`.
2. Else (attached+busy or detached): `queue.push(url)`.
3. If `currentSubscriber === null && !isSpawnInFlight()`: `spawnInFlightSince = now()`, `openUrlImpl(hubUrl(port))`.

**`attach(sub)` rules.**
1. If prior `currentSubscriber !== null`: write `{type:"displaced"}`, call `close()`.
2. Install new subscriber.
3. Clear `spawnInFlightSince = null` (success).
4. If `activeUrl !== null`: write resend navigate with `activeSeq` (recovery).
5. Else if `queue.length > 0`: shift front, `activeUrl = front`, `activeSeq = nextSeq++`, write navigate.
6. Return a detach callback: `() => { if (currentSubscriber === sub) currentSubscriber = null; }`.

**`markDone(seq)` rules.**
1. If `activeSeq !== seq`: no-op (idempotent).
2. Else `activeUrl = null`, `activeSeq = null`.
3. If `queue.length > 0 && currentSubscriber !== null`: shift front, set active, write navigate.

**`isSpawnInFlight()` rule.** `spawnInFlightSince !== null && (now() - spawnInFlightSince) < SPAWN_TIMEOUT_MS`. Resolved on attach.

**`withHubSeq(raw, seq)` rule.**
```ts
function withHubSeq(raw: string, seq: number): string {
  const u = new URL(raw);
  u.searchParams.set("hub_seq", String(seq));
  return u.toString();
}
```
Preserves other query params (id, token) unchanged.

### 2. `src/daemon/hub/hub-server.ts`

Three routes registered via the existing `DaemonServer` primitives. All use `addRouteRaw` (per-URL-token auth bypasses bearer); response writes include the hardening triplet from Plan 4a.

**`GET /ui/hub?token=H`.**
- Validates `token` via `timingSafeEqual` against `hubBroker.hubToken()`. Mismatch → 401 `ui_token_mismatch`. Missing → 400 `bad_request`.
- Serves the static HTML at `src/daemon/hub/hub-ui.html`.
- Response headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Content-Type: text/html; charset=utf-8`.
- CSP: `default-src 'self'; frame-src 'self'; child-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`.

**`GET /ui/hub/stream?token=H`.**
- Token validation identical to `/ui/hub`.
- `Content-Type: text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no` (defense-in-depth against reverse-proxy buffering even though daemon binds 127.0.0.1).
- Builds a `HubSubscriber { write, close }` from the `ServerResponse`. `write(e)` does `res.write(\`data: ${JSON.stringify(e)}\n\n\`)` guarded by `res.writableEnded || res.destroyed`. `close()` does `res.end()` guarded the same way.
- Calls `hubBroker.attach(sub)`. Wires `req.on("close", detach)` where `detach` is the callback returned by `attach`.
- Sends `: ping\n\n` every 25s as keep-alive (defense-in-depth against intermediary idle-close).

**`POST /ui/hub/done?token=H`.**
- Token validation identical.
- Body: `{ seq: number }`. Strict: missing → 400 `missing_param`. Non-integer or negative → 400 `bad_request`.
- Calls `hubBroker.markDone(seq)`. Returns `{ ok: true }` always (idempotent).

### 3. `src/daemon/hub/hub-ui.html`

Inline HTML, CSS, and JS. No external assets.

**Structure:**
- Top status bar (~32px): shows connection state (`connected` / `reconnecting…` / `disconnected` / `displaced`), daemon port, vault state (`unlocked` / `locked`). No token preview. No version info.
- Below status bar: `<iframe id="op" sandbox="allow-scripts allow-same-origin allow-forms">` — full remaining viewport. Initially empty/hidden until first navigate.

**JS contract.**
```js
const params = new URLSearchParams(location.search);
const hubToken = params.get("token");
const iframe = document.getElementById("op");
const statusEl = document.getElementById("status");

let terminal = false;
let attemptedReconnect = false;
let es = null;

function showBanner(text, kind) { /* updates statusEl + iframe area as needed */ }

function handleNavigate(url, seq) {
  // url has hub_seq already appended by broker; iframe page parses it.
  iframe.src = url;
}

function onMessage(ev) {
  const data = JSON.parse(ev.data);
  if (data.type === "displaced") {
    terminal = true;
    es.close();
    showBanner("Another tab is now driving Secret Shuttle. Reload here to take back over.", "displaced");
    return;
  }
  if (data.type === "navigate") {
    handleNavigate(data.url, data.seq);
  }
}

function connect() {
  es = new EventSource(`/ui/hub/stream?token=${encodeURIComponent(hubToken)}`);
  es.addEventListener("message", onMessage);
  es.addEventListener("error", () => {
    if (terminal) return;
    es.close();
    if (!attemptedReconnect) {
      attemptedReconnect = true;
      showBanner("Reconnecting…", "reconnecting");
      setTimeout(connect, 1000);
    } else {
      terminal = true;
      showBanner("Disconnected from Secret Shuttle. Reload to reconnect.", "disconnected");
    }
  });
}

window.addEventListener("message", async (ev) => {
  if (ev.origin !== location.origin) return;
  if (ev.source !== iframe.contentWindow) return;
  const data = ev.data;
  if (data?.type !== "operation_done") return;
  if (!Number.isSafeInteger(data.seq) || data.seq <= 0) return;
  await fetch(`/ui/hub/done?token=${encodeURIComponent(hubToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seq: data.seq }),
  });
});

connect();
```

### 4. Operation-page modifications

All three pages add `hub_seq` parsing + `notifyHubIfFramed()` + polling. Patterns differ slightly per page because of their existing JS structure.

**`src/daemon/approvals/ui.html` (`/ui/approve`).**
- Add to existing inline script:
  ```js
  const params = new URLSearchParams(location.search);
  const rawHubSeq = params.get("hub_seq");
  const parsedHubSeq = rawHubSeq === null ? null : Number(rawHubSeq);
  const hasHubSeq = parsedHubSeq !== null && Number.isSafeInteger(parsedHubSeq) && parsedHubSeq > 0;

  function notifyHubIfFramed() {
    if (!hasHubSeq) return;
    if (window.parent === window) return;
    window.parent.postMessage({ type: "operation_done", seq: parsedHubSeq }, location.origin);
  }

  const terminalStatuses = new Set(["granted", "denied", "expired", "used", "revoked"]);
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
  ```
- Call `startPolling()` after the initial JSON fetch sets up the page.
- Inside the approve/deny success handler, after the existing UI update: `stopPolling(); notifyHubIfFramed();`.

**`src/daemon/approvals/session-ui.html` (`/ui/session`).**
- Same pattern; polls `/ui/sessions/${id}?token=${token}`.
- Terminal statuses: `["granted", "denied", "expired", "revoked"]` (no `used` — sessions don't have that state per `src/daemon/approvals/session.ts`).
- Inside the existing `done()` function: after `status.textContent = ...`, call `notifyHubIfFramed()` and `stopPolling()`.

**`src/daemon/approvals/unlock-ui.html` (`/ui/unlock`).**
- Add only the `hub_seq` parsing + `notifyHubIfFramed()` (no polling).
- Inside the success branch (`document.body.innerHTML = "Unlocked. You can close this window."`): call `notifyHubIfFramed()`.
- Failure stays in the form for retry — no notify.
- Documented in CHANGELOG: unlock is blocking; hub queue waits on user success or tab close.

### 5. `src/daemon/services.ts`

Adds:
```ts
import { HubBroker } from "./hub/hub-broker.js";
// inside DaemonServices:
readonly hubBroker = new HubBroker();
```

### 6. `src/daemon/api/router.ts`

Adds `registerHubRoutes(server, services.hubBroker)` after the existing `registerUiRoutes` / `registerSessionUiRoutes`. Order doesn't matter (no regex overlap).

### 7. CSP relaxation on three operation routes

Each route currently sets `frame-ancestors 'none'` (session-ui) or no CSP header at all (ui.html, unlock). Relax to `frame-ancestors 'self'`:

- **`src/daemon/approvals/ui-server.ts`** — `/ui/approve` static HTML. Currently no CSP. Add the same hardened header as session-ui but with `frame-ancestors 'self'`.
- **`src/daemon/approvals/session-ui-server.ts`** — change `frame-ancestors 'none'` → `'self'` on the GET `/ui/session` handler. JSON sub-routes (`/ui/sessions/:id` and approve/deny) stay unchanged.
- **`src/daemon/api/routes/unlock-session.ts`** — verify if unlock UI sets CSP (probably doesn't); add the same header with `frame-ancestors 'self'`.

CSP after relaxation: `default-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`.

### 8. Call-site swaps

**Helper:** `src/daemon/hub/route-helpers.ts`:
```ts
export function makeHubOpenUrlImpl(
  services: DaemonServices,
  daemonPortRef: () => number,
): (url: string) => void {
  return (url) => services.hubBroker.surface(url, daemonPortRef());
}
```

**9 approval-gated routes** (from Plan 4a I1) pass `openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef)` to `requireApproval`. Routes:
1. `src/daemon/api/routes/templates.ts`
2. `src/daemon/api/routes/secrets.ts` (`/v1/secrets/generate`)
3. `src/daemon/api/routes/inject-submit.ts`
4. `src/daemon/api/routes/reveal-capture.ts`
5. `src/daemon/api/routes/run-resolve.ts`
6. `src/daemon/api/routes/inject-render.ts`
7. `src/daemon/api/routes/secrets-delete.ts`
8. `src/daemon/api/routes/secrets-rotate.ts`
9. `src/daemon/api/routes/blind.ts` (only the `/v1/blind/end` handler)

**2 direct call sites** replace `openUrl(url)` with `services.hubBroker.surface(url, daemonPortRef())`:
- `src/daemon/api/routes/approvals-session.ts:29`
- `src/daemon/api/routes/unlock-session.ts:24`

---

## Data flow

### Cold start, single op
1. CLI invokes production op. Daemon's route builds the approval grant, calls `requireApproval({..., openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef)})`.
2. `requireApproval` constructs `operationUrl = http://127.0.0.1:P/ui/approve?id=&token=`, calls `openUrlImpl(operationUrl)`.
3. `makeHubOpenUrlImpl` thunks to `services.hubBroker.surface(operationUrl, port)`.
4. `surface()`: detached, queue empty, `!isSpawnInFlight()`. Pushes to queue, calls `openUrl(hubUrl)`, sets `spawnInFlightSince = now`.
5. Browser opens `http://127.0.0.1:P/ui/hub?token=H`. Hub page renders shell + `EventSource("/ui/hub/stream?token=H")`.
6. SSE route validates token, builds `HubSubscriber`, calls `hubBroker.attach(sub)`. Broker has no prior; drains queue front to active (seq=1), writes `{type:"navigate", url: withHubSeq(operationUrl, 1), seq: 1}`.
7. Hub JS sets `iframe.src = url`. Iframe loads `/ui/approve?id=&token=&hub_seq=1`. Inline JS parses `hub_seq`. User clicks Approve → POSTs `/ui/approvals/:id/approve?token=` → 200. Approve handler calls `notifyHubIfFramed()` + `stopPolling()`.
8. Iframe `window.parent.postMessage({type:"operation_done", seq: 1}, location.origin)`. Hub receives, validates origin+source, POSTs `/ui/hub/done?token=H { seq: 1 }`.
9. Broker `markDone(1)` matches, clears active, queue empty, no further writes.
10. CLI side: daemon poll-loop sees grant flip → returns success.

### Two surfaces while detached (FIFO burst)
1. `surface(url1)`: queue=`[url1]`. Detached, !inFlight. Spawn #1, `spawnInFlightSince = T0`.
2. `surface(url2)` at T0+100ms: queue=`[url1, url2]`. Detached, isSpawnInFlight (100ms < 5s). Enqueue only, no respawn.
3. Hub loads, attach(sub). spawnInFlightSince cleared. Active=`null`, queue non-empty → promote `url1` to active (seq=1), navigate. Queue=`[url2]`.
4. User approves op1 → markDone(1) → clear active → promote `url2` (seq=2) → navigate to current sub.
5. User approves op2 → markDone(2) → empty.

### Two surfaces while attached
1. `surface(url1)`: attached + idle → active=`url1` (seq=1), navigate. Queue=`[]`.
2. `surface(url2)`: attached + active set → enqueue. Queue=`[url2]`. No write.
3. User approves op1 → markDone(1) → promote `url2` (seq=2) → navigate.

### User closes hub mid-op + new surface (recovery)
1. State: active=`url1` (seq=1), queue=`[]`, subscriber=hub1. spawnInFlightSince=null (cleared on attach).
2. Hub1 closes (SSE drop). detach callback nulls currentSubscriber. activeUrl unchanged.
3. `surface(url3)`: attached? no. Push to queue. queue=`[url3]`. !isSpawnInFlight (null) → spawn #2.
4. New hub attaches. activeUrl=`url1` set → resend navigate(url1, seq=1).
5. Iframe loads `/ui/approve?id=&token=&hub_seq=1` for op 1. Either grant is still pending (user can act) OR has timed out (polling sees terminal → notify → advance).
6. Op 1 resolves → markDone(1) → promote url3 (seq=2) → navigate.

### Tab-close before attach (debounce edge)
1. `surface(url1)`: detached, !inFlight. Spawn #1, `spawnInFlightSince = T0`.
2. User dismisses tab at T0+100ms before SSE attaches.
3. `surface(url2)` at T0+200ms: detached, isSpawnInFlight (200ms < 5s) → enqueue only, no respawn. queue=`[url1, url2]`.
4. Synthetic time advances to T0+5001ms.
5. `surface(url3)`: detached, !isSpawnInFlight (5001ms > 5000ms) → spawn #2, `spawnInFlightSince = T0+5001`. queue=`[url1, url2, url3]`.
6. Hub attaches → drain via activeUrl=`url1` then markDone-driven promotion to url2, url3.

### Displacement (second hub tab opened manually)
1. State: active=`url1`, subscriber=hub1.
2. User loads `http://127.0.0.1:P/ui/hub?token=H` in tab #2.
3. Tab #2's SSE attaches. attach() writes `{type:"displaced"}` to hub1, calls `close()`.
4. Hub1's `onMessage` handler sees `displaced` → sets `terminal=true` → `es.close()` → renders displaced banner. Crucially, `terminal=true` BEFORE `close()` so the subsequent `onerror` (fired by close) is suppressed by the early `if (terminal) return;`.
5. Tab #2 becomes the active hub. Receives resend of `url1` (recovery path).

### SSE drop without close
1. State: active set, subscriber=hub1.
2. Network/proxy hiccup → `es.onerror` fires. `terminal=false`, `attemptedReconnect=false`. `es.close()`, `attemptedReconnect=true`, setTimeout(connect, 1000).
3. Successful reconnect → new EventSource → SSE route attaches → broker displaces zombie (close() is no-op on torn-down res) → resend active.
4. Second consecutive error → `terminal=true`, render "Disconnected — reload to reconnect."

### Daemon-driven cleanup of expired grant
1. Grant `url1` is active in iframe. User walks away.
2. After 2 min, ApprovalStore marks grant expired.
3. Iframe's polling loop fetches `/ui/approvals/:id?token=` every 2s → first poll after expiry sees `status === "expired"` → `notifyHubIfFramed()` → POST `/ui/hub/done` → broker advances. Queue self-drains.

### Idempotent done
1. Iframe accidentally emits `operation_done` twice (e.g., approve POST AND poll both terminal).
2. Hub POSTs `/ui/hub/done {seq:1}` twice. First call: `activeSeq===1`, match, advance, `activeSeq=2`. Second call: `activeSeq===2 !== 1` → no-op. Safe.

---

## Error handling

**Auth.** All three hub routes use `timingSafeEqual` on `hub_token`. 401 with structured-error body on mismatch.

**SSE writer guards.** Every `res.write` in the SSE handler checks `res.writableEnded || res.destroyed` first (mirrors Plan 3 R5-1 pattern).

**Hub HTML JS terminal-state flag.** One `terminal: boolean` gates all reconnect logic. Both error-path and displaced-path flip it before any `es.close()` (which itself fires another `onerror` we want suppressed).

**Iframe failures.**
- `iframe.onerror` (browser fails to load): show inline banner "Failed to load approval page. Reload to retry." activeUrl preserved daemon-side → next attach resends.
- Non-Secret-Shuttle postMessage from iframe: rejected via `event.source === iframe.contentWindow && event.origin === location.origin` check.

**Daemon process lifecycle.** Daemon restart → new `hub_token` → any still-open hub from prior process gets 401 on next SSE attempt → banner appears → user reloads. No persistence, no migration needed.

**Test bypass.** `SECRET_SHUTTLE_NO_OPEN_URL=1` continues to short-circuit `openUrl`. HubBroker calls `openUrl` for the hub spawn, so the env var disables spawn entirely under test. Tests inject `openUrlImpl: spy` for state-machine coverage.

**Queue cap.** No explicit cap for v0.2.0. Per-grant TTLs (2 min for single-use approval, 15 min max for sessions) plus polling-driven self-drain bound the queue in practice. If real-world usage hits this, add `queue.length > 100 → throw hub_queue_full` in 0.3.

---

## Testing

### Layer 1 — HubBroker unit tests
Pure state machine; injected clock + openUrlImpl spy + fake `HubSubscriber`. New file: `src/daemon/hub/hub-broker.test.ts`.

Cases:
- `surface` attached+idle → navigate written, active set.
- `surface` attached+busy → enqueue only, no write.
- `surface` detached + no spawn → spawn #1, `spawnInFlightSince` set.
- `surface` detached + within timeout → enqueue, no respawn.
- `surface` detached + past timeout → respawn.
- `surface` detached + activeUrl set (post-close) → enqueue + respawn (because `isSpawnInFlight()` is false after attach cleared it).
- `attach` empty broker → no resend, drains queue front if present.
- `attach` with active set → resend navigate(active, activeSeq).
- `attach` displaces prior → prior gets `displaced` event + `close()`; new gets resend or promotion.
- `attach` clears `spawnInFlightSince`.
- `markDone` matching → clear, promote next.
- `markDone` mismatched (stale/dup) → no-op, no further writes.
- `markDone` with empty queue → clear active only.
- `withHubSeq()` appends hub_seq, preserves other params, replaces existing hub_seq if present.
- FIFO ordering across surface/markDone interleavings.
- `hubUrl(port)` returns absolute `http://127.0.0.1:${port}/ui/hub?token=…`.
- `tokenMatches` constant-time compare against `hubToken`.

### Layer 2 — Hub route tests
Real `DaemonServer` + temp homedir; mirrors `session-ui-server.test.ts` harness. New file: `src/daemon/hub/hub-server.test.ts`.

Cases:
- `GET /ui/hub?token=H` valid → 200, `text/html`, hardening headers + CSP including `frame-src 'self'` and `connect-src 'self'`.
- `GET /ui/hub?token=WRONG` → 401 `ui_token_mismatch`.
- `GET /ui/hub` (no token) → 400 `bad_request`.
- `GET /ui/hub/stream?token=H` valid → response `text/event-stream`. After `services.hubBroker.surface(url, port)`, the SSE response receives a parseable `data:` frame with `{type:"navigate", url, seq}`.
- `GET /ui/hub/stream?token=WRONG` → 401, no body bytes.
- Two simultaneous SSE connections → first receives `{type:"displaced"}` then closes; second receives resend.
- `POST /ui/hub/done?token=H {seq:N}` valid + matching → 200 `{ok:true}`; broker advances.
- `POST /ui/hub/done?token=WRONG` → 401.
- `POST /ui/hub/done` mismatched seq → 200 (idempotent).
- `POST /ui/hub/done` missing body / malformed body → 400 `missing_param` or `bad_request`.

### Layer 3 — Operation-page CSP regression
Targeted assertions on the three operation routes. Files: existing `ui-server.test.ts` (extend), existing `session-ui-server.test.ts` (extend), new test for unlock UI if not yet covered.

Cases:
- `/ui/approve` CSP contains `frame-ancestors 'self'`, not `'none'`, with other directives unchanged.
- `/ui/session` CSP changed from `'none'` to `'self'` for frame-ancestors only.
- Unlock UI route CSP includes `frame-ancestors 'self'`.

### Layer 4 — Operation-page polling regression
Extend existing route tests for `/ui/approve` and `/ui/session`. Cases:
- Page-load JSON fetch contract unchanged (test reads `/ui/approvals/:id?token=`, asserts response shape).
- Note (for review only — not a daemon test): the inline JS in `ui.html` / `session-ui.html` polls every 2s. Cover via JS unit test if a test runner is set up; otherwise document the polling contract in a `// PLAN 4B:` comment block.

### Layer 5 — End-to-end via real broker
Real `HubBroker` + real route harness + fake `openUrlImpl` spy. New file: `src/daemon/hub/hub-e2e.test.ts`.

Cases (named to mirror data flow):
- **"Single approval via hub"**: trigger production op → broker surface → assert openUrlSpy was called once with absolute hub URL → fake SSE client attaches → asserts first event is navigate with `hub_seq=1` → simulate `markDone(1)` via POST `/ui/hub/done` → asserts no further events.
- **"Burst while detached"**: surface 3 URLs in rapid succession (synthetic clock); assert openUrlSpy called once; attach → assert active is url1, queue drains via 2 markDone calls.
- **"Tab-close mid-op + post-timeout recovery"** (3 opens variant):
  1. `surface(url1)` → spawn #1.
  2. `attach(sub1)` → drain → navigate(url1, seq=1). `spawnInFlightSince=null`.
  3. `sub1.close()` — simulate hub close, no markDone. activeUrl preserved.
  4. `surface(url2)` → !isSpawnInFlight → spawn #2. queue=[url2].
  5. Advance synthetic clock by 5001ms.
  6. `surface(url3)` → !isSpawnInFlight (timeout) → spawn #3. queue=[url2, url3].
  7. `attach(sub2)` → activeUrl=url1 → resend navigate(url1, seq=1). markDone(1) → promote url2 (seq=2). markDone(2) → promote url3 (seq=3). markDone(3) → empty.
  - **Assertions:** `openUrlSpy.calls.length === 3`. Subscriber received events: `[displaced (no — first attach), navigate(url1,1), navigate(url1,1), navigate(url2,2), navigate(url3,3)]` — the first attach has no prior to displace; the second attach gets a resend.
- **"Tab-close mid-op stays within spawn window"** (2 opens variant): Steps 1–4 above, skip 5–6, attach sub2. Asserts `openUrlSpy.calls.length === 2` and resend-then-drain.

### Layer 6 — `SECRET_SHUTTLE_NO_OPEN_URL` regression
With env var set: `surface()` works (state mutates), `openUrl` no-ops. Test:
- New `HubBroker()` (real `openUrl`, not spy).
- `surface(url, port)` while env var set.
- Assert no child process spawned (mock via existing `openUrl` test pattern).
- Manual `attach(fakeSub)` proceeds normally — state machine doesn't care.

---

## Acceptance criteria

- Single approval flow opens exactly one tab; subsequent approvals reuse it.
- Burst of N approvals in rapid succession opens exactly one tab; all N drain in FIFO order.
- Closing the hub tab and triggering a new approval respawns within ≤ SPAWN_TIMEOUT_MS (default 5s).
- Opening a second hub tab manually displaces the first cleanly (no reconnect war).
- Hub tab survives SSE network blip with one auto-reconnect attempt; second failure leaves user with a clear banner.
- Per-URL `ui_token` security property unchanged (each operation's iframe still authenticates via its own token).
- `SECRET_SHUTTLE_NO_OPEN_URL=1` continues to fully silence tab spawning.
- Test suite passes; new tests in `hub-broker.test.ts`, `hub-server.test.ts`, `hub-e2e.test.ts`; existing CSP tests updated for `frame-ancestors 'self'`.
- CHANGELOG documents: tab-reuse mechanism, CSP relaxation (operational tradeoff), the unlock UI's blocking semantics.

---

## File summary

**New files:**
- `src/daemon/hub/hub-broker.ts` (state machine)
- `src/daemon/hub/hub-broker.test.ts`
- `src/daemon/hub/hub-server.ts` (3 routes)
- `src/daemon/hub/hub-server.test.ts`
- `src/daemon/hub/hub-ui.html`
- `src/daemon/hub/route-helpers.ts` (`makeHubOpenUrlImpl`)
- `src/daemon/hub/hub-e2e.test.ts`

**Modified files:**
- `src/daemon/services.ts` — add `hubBroker`.
- `src/daemon/api/router.ts` — register hub routes.
- `src/daemon/approvals/ui-server.ts` — add CSP header with `frame-ancestors 'self'`.
- `src/daemon/approvals/session-ui-server.ts` — change `frame-ancestors 'none'` → `'self'`.
- `src/daemon/api/routes/unlock-session.ts` — add CSP header (or equivalent for unlock UI route).
- `src/daemon/approvals/ui.html` — hub_seq parse + polling + notifyHubIfFramed.
- `src/daemon/approvals/session-ui.html` — same shape adapted for session terminal statuses.
- `src/daemon/approvals/unlock-ui.html` — hub_seq parse + notifyHubIfFramed on success only.
- Nine approval-gated route files (Plan 4a I1 list) — pass `openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef)` to `requireApproval`.
- `src/daemon/api/routes/approvals-session.ts:29` — replace `openUrl(...)` with `services.hubBroker.surface(...)`.
- `src/daemon/api/routes/unlock-session.ts:24` — same.
- `package.json` build script — copy `src/daemon/hub/hub-ui.html` to `dist/daemon/hub/hub-ui.html` alongside the existing `ui.html` / `unlock-ui.html` / `session-ui.html` copies.
- `CHANGELOG.md` — Plan 4b section under `## Unreleased`.

---

## Out-of-scope items explicitly deferred

- **Nonce-based CSP.** Plan 4b ships with `script-src 'self' 'unsafe-inline'` on all UI routes. A nonce-based CSP that drops `'unsafe-inline'` is a future hardening pass.
- **Queue cap.** Self-limiting via TTL + polling for v0.2.0. Explicit `hub_queue_full` error in 0.3 if needed.
- **CLI verb `secret-shuttle hub open`.** No CLI surface added in 4b. If a user wants to manually open the hub, they reload an open hub tab (banner says "reload here to take back over") OR restart the daemon (new hub_token, fresh tab on next operation). Future: add the CLI verb if real workflows need it.
- **Hub-token rotation.** Token is daemon-lifetime. Rotation requires daemon restart. Acceptable given the low blast radius (token is in-memory only, never written to disk or socket file, daemon binds 127.0.0.1).
- **Persisted queue across daemon restart.** Daemon restart loses the queue. CLI clients re-emit their requests on next call (or fail with the existing approval_timeout). Persistence is not required.
