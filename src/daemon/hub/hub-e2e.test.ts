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

test("e2e: production stdin op → hub surface → approve → child reads value", async () => {
  await withE2EDaemon(async (ctx) => {
    // Unlock the vault so the run-resolve route can resolve refs.
    const unlockRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "p", set_passphrase: true }),
    });
    assert.equal(unlockRes.status, 200);

    // Seed a production secret with use_as_stdin allowed. allowed_domains is
    // required by the vault contract for production refs; canonicalized to
    // null SessionAction on the run_stdin path so the value is irrelevant.
    await ctx.services.vault.upsertSecret({
      source: "local",
      environment: "production",
      name: "PROD_STDIN",
      value: "prod-secret-value",
      allowedDomains: ["docker.io"],
      allowedActions: ["use_as_stdin"],
    });

    // Pre-attach a fake subscriber so the broker's surface() routes the
    // approval URL into `activeUrl` (instead of just queueing it). Without
    // an attached subscriber, peekState().activeUrl would stay null and the
    // poll loop below would time out.
    const { sub, events } = makeSub();
    ctx.broker.attach(sub);

    // Fire the run-resolve request. Don't await — the daemon will block in
    // requireApproval's polling loop until we approve via the hub-surfaced URL.
    const responsePromise = fetch(`http://127.0.0.1:${ctx.port}/v1/run/resolve`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        refs: [],
        env: [],
        command: "cat",
        args: [],
        cwd: process.cwd(),
        stdin_ref: "ss://local/prod/PROD_STDIN",
      }),
    });

    // Poll the broker for the pending operation. requireApproval calls
    // openUrlImpl → broker.surface → activeUrl is set (because we attached
    // above). ~50ms window is typical; 2s is generous.
    let pending: { url: string; seq: number } | undefined;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && pending === undefined) {
      const state = ctx.broker.peekState();
      if (state.activeUrl !== null && state.activeSeq !== null) {
        pending = { url: state.activeUrl, seq: state.activeSeq };
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(pending, "expected a pending operation URL in the hub broker");

    // Sanity: the subscriber should have received the matching navigate event.
    assert.equal(events.length, 1);
    assert.equal((events[0] as Extract<HubEvent, { type: "navigate" }>).type, "navigate");

    // Extract id + token and approve via the existing /ui/approvals/:id/approve
    // route. The per-URL token is the grant's ui_token; the approve POST flips
    // status:pending → status:granted which unblocks the daemon's wait loop.
    const url = new URL(pending!.url);
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    assert.ok(id && token, "approval URL must carry id + token");
    const approveRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${id}/approve?token=${encodeURIComponent(token!)}`,
      { method: "POST" },
    );
    assert.equal(approveRes.status, 200);

    // Now await the streamed response. The daemon resumes, spawns `cat`,
    // pipes the resolved secret to fd 0, and the masker replaces the
    // echoed value with `***` before relay.
    const res = await responsePromise;
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /ndjson/);

    // Drain the ndjson stream into lines.
    const lines: Record<string, unknown>[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (raw.trim().length === 0) continue;
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
    }

    const exitLine = lines.find((l) => "exit" in l) as { exit: number } | undefined;
    assert.equal(exitLine?.exit, 0);

    // The cat child read the secret value and echoed it; the masker
    // converted it to *** before relay. No raw plaintext on the wire.
    const stdout = lines
      .filter((l) => "stream" in l && (l as { stream: string }).stream === "stdout")
      .map((l) => Buffer.from((l as { data: string }).data, "base64").toString("utf8"))
      .join("");
    assert.equal(stdout, "***");
    assert.equal(stdout.includes("prod-secret-value"), false, "raw secret leaked into stdout");
  });
});

// Note: waiting-flow path surfaces approvals sequentially. requireApprovals (Case C)
// awaits the first grant before calling open() on the second URL — so the broker's
// activeUrl is cleared between the two surfaces. This proves env-first/stdin-second
// ORDER, not pre-queued FIFO. The pre-queued path (where multiple URLs are
// surfaced before any subscriber attaches) is exercised by other hub-broker unit tests.

test("hub e2e: combined production env+stdin --no-wait path surfaces both URLs (Plan 4d)", async () => {
  await withE2EDaemon(async (ctx) => {
    // Unlock the vault so run-resolve can resolve production refs.
    const unlockRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "p", set_passphrase: true }),
    });
    assert.equal(unlockRes.status, 200);

    // Seed two production secrets: one env ref, one stdin ref.
    await ctx.services.vault.upsertSecret({
      source: "local",
      environment: "production",
      name: "NW_ENV",
      value: "nw-env-value",
      allowedDomains: ["docker.io"],
      allowedActions: ["use_as_stdin"],
    });
    await ctx.services.vault.upsertSecret({
      source: "local",
      environment: "production",
      name: "NW_STDIN",
      value: "nw-stdin-value",
      allowedDomains: ["docker.io"],
      allowedActions: ["use_as_stdin"],
    });

    const envRef = "ss://local/prod/NW_ENV";
    const stdinRef = "ss://local/prod/NW_STDIN";

    // Pre-attach a fake subscriber so broker.surface() promotes the first
    // URL directly to activeUrl (instead of keeping it detached-queued).
    const { sub } = makeSub();
    ctx.broker.attach(sub);

    // ── First POST: --no-wait (wait_for_approval: false) ─────────────────────
    // requireApprovals Case B: atomically mints BOTH approvals, surfaces BOTH
    // URLs via openUrlImpl, then throws approval_required with details.approvals
    // length 2. The broker receives both surface() calls in one synchronous burst.

    const firstRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/run/resolve`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        refs: [envRef],
        env: [{ key: "NW_ENV", value: envRef, isRef: true }],
        command: "sh",
        args: ["-c", "echo $NW_ENV; cat"],
        cwd: process.cwd(),
        stdin_ref: stdinRef,
        wait_for_approval: false,
      }),
    });
    assert.equal(firstRes.status, 400, "first POST must return 400 approval_required");

    const firstBody = await firstRes.json() as Record<string, unknown>;
    assert.equal(firstBody["error_code"], "approval_required");
    const details = firstBody["details"] as { approvals: Array<{ approval_id: string; expires_at: number; action: string }> };
    assert.ok(Array.isArray(details?.approvals), "details.approvals must be an array");
    assert.equal(details.approvals.length, 2, "details.approvals must have 2 entries (env + stdin)");
    assert.equal(details.approvals[0]!.action, "run", "first approval must be env binding (action=run)");
    assert.equal(details.approvals[1]!.action, "run_stdin", "second approval must be stdin binding (action=run_stdin)");

    const envId = details.approvals[0]!.approval_id;
    const stdinId = details.approvals[1]!.approval_id;

    // ── Verify broker received BOTH surface() calls ───────────────────────────
    // Case B surfaces all URLs atomically (both in one synchronous burst before
    // throwing). With a subscriber attached, the first goes to activeUrl and the
    // second is queued. After the burst: queueLength >= 1 OR both are already
    // accounted for in the active+queue state.
    const stateAfterFirst = ctx.broker.peekState();
    assert.ok(
      stateAfterFirst.activeUrl !== null || stateAfterFirst.queueLength > 0,
      "broker must have at least one URL surfaced after the --no-wait call",
    );
    // Total surfaced (active=1 + queued) should be 2.
    const totalSurfaced = (stateAfterFirst.activeUrl !== null ? 1 : 0) + stateAfterFirst.queueLength;
    assert.equal(totalSurfaced, 2, "broker must have received exactly 2 surface() calls (one per approval)");

    // ── Approve env (first, active URL) via UI route ─────────────────────────
    // The env approval is the active one (first surface() call wins the slot).
    let activeState = ctx.broker.peekState();
    assert.ok(activeState.activeUrl !== null && activeState.activeSeq !== null);
    const activeUrl = new URL(activeState.activeUrl!);
    const activeId = activeUrl.searchParams.get("id")!;
    const activeToken = activeUrl.searchParams.get("token")!;
    assert.equal(activeId, envId, "active URL must be the env approval");

    const approveEnvRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${activeId}/approve?token=${encodeURIComponent(activeToken)}`,
      { method: "POST" },
    );
    assert.equal(approveEnvRes.status, 200);

    // Mark env done — clears activeUrl, promotes queued stdin URL to active.
    const doneEnvRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: activeState.activeSeq! }),
      },
    );
    assert.equal(doneEnvRes.status, 200);

    // ── Verify stdin URL promoted to active ────────────────────────────────────
    // After markDone, the queued stdin URL should become the new activeUrl.
    let stdinState = ctx.broker.peekState();
    // Short poll to let the broker state settle (synchronous state machine — should be immediate).
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && stdinState.activeUrl === null) {
      await new Promise((r) => setTimeout(r, 10));
      stdinState = ctx.broker.peekState();
    }
    assert.ok(stdinState.activeUrl !== null && stdinState.activeSeq !== null, "stdin URL must become active after env markDone");

    const stdinActiveUrl = new URL(stdinState.activeUrl!);
    const stdinActiveId = stdinActiveUrl.searchParams.get("id")!;
    const stdinActiveToken = stdinActiveUrl.searchParams.get("token")!;
    assert.equal(stdinActiveId, stdinId, "active URL after env done must be the stdin approval");

    // ── Approve stdin via UI route ─────────────────────────────────────────────
    const approveStdinRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${stdinActiveId}/approve?token=${encodeURIComponent(stdinActiveToken)}`,
      { method: "POST" },
    );
    assert.equal(approveStdinRes.status, 200);

    // Mark stdin done.
    const doneStdinRes = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: stdinState.activeSeq! }),
      },
    );
    assert.equal(doneStdinRes.status, 200);

    // ── Second POST: retry with approval_ids ──────────────────────────────────
    // Both approvals are now status:granted. Retry with approval_ids: [envId, stdinId].
    // requireApprovals Case A: no mints needed, both consumed → command runs.
    const retryRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/run/resolve`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        refs: [envRef],
        env: [{ key: "NW_ENV", value: envRef, isRef: true }],
        command: "sh",
        args: ["-c", "echo $NW_ENV; cat"],
        cwd: process.cwd(),
        stdin_ref: stdinRef,
        approval_ids: [envId, stdinId],
      }),
    });
    assert.equal(retryRes.status, 200, "retry with both approval IDs must succeed");
    assert.match(retryRes.headers.get("content-type") ?? "", /ndjson/);

    // Drain the ndjson stream.
    const lines: Record<string, unknown>[] = [];
    const reader = retryRes.body!.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (raw.trim().length === 0) continue;
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
    }

    const exitLine = lines.find((l) => "exit" in l) as { exit: number } | undefined;
    assert.equal(exitLine?.exit, 0, "--no-wait retry must exit 0");

    // Masker must have replaced both secret values with ***.
    const stdout = lines
      .filter((l) => "stream" in l && (l as { stream: string }).stream === "stdout")
      .map((l) => Buffer.from((l as { data: string }).data, "base64").toString("utf8"))
      .join("");
    assert.equal(stdout.includes("nw-env-value"), false, "env secret must not leak into stdout");
    assert.equal(stdout.includes("nw-stdin-value"), false, "stdin secret must not leak into stdout");
    assert.match(stdout, /\*\*\*/, "masked placeholder *** must appear in stdout");
  });
});

test("hub e2e: combined production env+stdin via sequential hub promotion (Plan 4d)", async () => {
  await withE2EDaemon(async (ctx) => {
    // Unlock the vault so run-resolve can resolve production refs.
    const unlockRes = await fetch(`http://127.0.0.1:${ctx.port}/v1/unlock`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "p", set_passphrase: true }),
    });
    assert.equal(unlockRes.status, 200);

    // Seed two production secrets: one used as an env-file ref, one as stdin.
    await ctx.services.vault.upsertSecret({
      source: "local",
      environment: "production",
      name: "COMBINED_ENV",
      value: "combined-env-value",
      allowedDomains: ["docker.io"],
      allowedActions: ["use_as_stdin"],
    });
    await ctx.services.vault.upsertSecret({
      source: "local",
      environment: "production",
      name: "COMBINED_STDIN",
      value: "combined-stdin-value",
      allowedDomains: ["docker.io"],
      allowedActions: ["use_as_stdin"],
    });

    const envRef = "ss://local/prod/COMBINED_ENV";
    const stdinRef = "ss://local/prod/COMBINED_STDIN";

    // Pre-attach a fake subscriber so broker.surface() promotes the first
    // approval URL directly to activeUrl (instead of enqueueing it detached).
    // Without this, peekState().activeUrl stays null until attach() drains.
    const { sub, events } = makeSub();
    ctx.broker.attach(sub);

    // Fire the run-resolve request without --no-wait (waiting flow) and without
    // providing approval_ids. requireApprovals will mint both grants and surface
    // them sequentially via the broker: env first, then stdin after env is
    // approved and the waitForGrant loop resolves.
    // Use `sh -c 'echo $COMBINED_ENV; cat'` so both secret values appear in
    // stdout and the masker replaces each with ***.
    const responsePromise = fetch(`http://127.0.0.1:${ctx.port}/v1/run/resolve`, {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({
        refs: [envRef],
        env: [{ key: "COMBINED_ENV", value: envRef, isRef: true }],
        command: "sh",
        args: ["-c", "echo $COMBINED_ENV; cat"],
        cwd: process.cwd(),
        stdin_ref: stdinRef,
      }),
    });

    // ── First approval (env, action=run) ──────────────────────────────────────

    // Poll for the env approval URL. requireApprovals calls open(envUrl) which
    // calls broker.surface(); since we pre-attached above, activeUrl is set
    // immediately (subscriber attached + idle).
    let first: { url: string; seq: number } | undefined;
    const deadline1 = Date.now() + 2000;
    while (Date.now() < deadline1 && first === undefined) {
      const state = ctx.broker.peekState();
      if (state.activeUrl !== null && state.activeSeq !== null) {
        first = { url: state.activeUrl, seq: state.activeSeq };
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(first, "expected the env approval URL to surface in the hub broker");

    // The first navigate event must carry the env approval URL.
    assert.equal(events.length >= 1, true);
    const nav1 = events.find(
      (e) => e.type === "navigate" && (e as Extract<HubEvent, { type: "navigate" }>).seq === first!.seq,
    ) as Extract<HubEvent, { type: "navigate" }> | undefined;
    assert.ok(nav1, "subscriber must have received the first navigate event");

    // Approve the env grant via the UI route. This flips status:pending →
    // status:granted, unblocking requireApprovals' waitForGrant poll loop.
    const url1 = new URL(first.url);
    const id1 = url1.searchParams.get("id");
    const token1 = url1.searchParams.get("token");
    assert.ok(id1 && token1, "first approval URL must carry id + token");

    // Assert that the first approval is the env binding (action=run), not stdin.
    // If run-resolve reverses the binding order (stdin first, env second), this
    // assertion catches it: the first approval would have action="run_stdin".
    // The env binding has ref=null and carries refs via template_params.refs.
    const firstApproval = ctx.services.approvals.get(id1!);
    assert.ok(firstApproval, "first approval must exist in store");
    assert.strictEqual(firstApproval.action, "run", "first approval must be the env binding (action=run)");
    assert.strictEqual(firstApproval.ref, null, "env binding carries ref=null (refs are in template_params.refs)");
    assert.ok(
      (firstApproval.template_params?.["refs"] as string | undefined)?.includes(envRef),
      "env binding template_params.refs must include the env secret ref",
    );

    const approveRes1 = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${id1}/approve?token=${encodeURIComponent(token1!)}`,
      { method: "POST" },
    );
    assert.equal(approveRes1.status, 200);

    // Mark the first slot done. This clears activeUrl in the broker.
    // Once waitForGrant resolves, requireApprovals calls open(stdinUrl);
    // broker.surface will either:
    //   (a) enqueue it (if markDone hasn't cleared activeUrl yet), or
    //   (b) set activeUrl directly (if activeUrl is already null).
    // Either way, after markDone the broker will have stdinUrl as activeUrl.
    const doneRes1 = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: first.seq }),
      },
    );
    assert.equal(doneRes1.status, 200);

    // ── Second approval (stdin, action=run_stdin) ─────────────────────────────

    // Poll for the stdin approval URL. requireApprovals' waitForGrant polls
    // every 200ms; once it sees status:granted it consumes the env grant and
    // calls open(stdinUrl) → broker.surface(stdinUrl). Combined with the
    // markDone above (which cleared activeUrl), stdinUrl becomes the new active.
    let second: { url: string; seq: number } | undefined;
    const deadline2 = Date.now() + 3000;
    while (Date.now() < deadline2 && second === undefined) {
      const state = ctx.broker.peekState();
      if (state.activeUrl !== null && state.activeSeq !== null && state.activeSeq !== first.seq) {
        second = { url: state.activeUrl, seq: state.activeSeq };
      } else {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.ok(second, "expected the stdin approval URL to surface after env was approved");

    // Approve the stdin grant via the UI route.
    const url2 = new URL(second.url);
    const id2 = url2.searchParams.get("id");
    const token2 = url2.searchParams.get("token");
    assert.ok(id2 && token2, "second approval URL must carry id + token");

    // Assert that the second approval is the stdin binding (action=run_stdin), not env.
    // If run-resolve reverses the binding order, the second approval would have
    // action="run" and this assertion would fail.
    // The stdin binding has ref=stdinRef (single canonical ref).
    const secondApproval = ctx.services.approvals.get(id2!);
    assert.ok(secondApproval, "second approval must exist in store");
    assert.strictEqual(secondApproval.action, "run_stdin", "second approval must be the stdin binding (action=run_stdin)");
    assert.strictEqual(secondApproval.ref, stdinRef, "stdin binding ref must match the stdin secret ref");

    const approveRes2 = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/approvals/${id2}/approve?token=${encodeURIComponent(token2!)}`,
      { method: "POST" },
    );
    assert.equal(approveRes2.status, 200);

    // Mark the second slot done.
    const doneRes2 = await fetch(
      `http://127.0.0.1:${ctx.port}/ui/hub/done?token=${encodeURIComponent(ctx.broker.hubToken())}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: second.seq }),
      },
    );
    assert.equal(doneRes2.status, 200);

    // ── Drain the streamed response ───────────────────────────────────────────

    // Now await the streamed response. Both grants are consumed; requireApprovals
    // returns → route spawns sh, injects env + stdin → masker replaces both
    // secret values with *** before relay.
    const res = await responsePromise;
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /ndjson/);

    const lines: Record<string, unknown>[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (raw.trim().length === 0) continue;
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
    }

    const exitLine = lines.find((l) => "exit" in l) as { exit: number } | undefined;
    assert.equal(exitLine?.exit, 0, "combined env+stdin run must exit 0");

    // The masker must have replaced both secret values with ***.
    // Neither raw plaintext should appear on the wire.
    const stdout = lines
      .filter((l) => "stream" in l && (l as { stream: string }).stream === "stdout")
      .map((l) => Buffer.from((l as { data: string }).data, "base64").toString("utf8"))
      .join("");
    assert.equal(stdout.includes("combined-env-value"), false, "env secret must not appear in stdout");
    assert.equal(stdout.includes("combined-stdin-value"), false, "stdin secret must not appear in stdout");
    assert.match(stdout, /\*\*\*/, "masked placeholder *** must appear in stdout");
  });
});
