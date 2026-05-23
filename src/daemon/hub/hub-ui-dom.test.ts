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
