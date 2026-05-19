import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import { CdpBrowserOps, ABSENCE_SCAN_FN } from "./internal-ops.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

class ScriptedTransport extends EventEmitter implements CdpTransport {
  // Configure the single page target's Runtime.evaluate result.
  scanValue: { found?: boolean; inconclusive?: boolean } | undefined = { found: false, inconclusive: false };
  scanThrows = false;
  observeValue: { host?: string; has?: boolean } = { host: "vercel.com", has: true };

  send(msg: Sent): void {
    const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    const fail = (m: string): void => queueMicrotask(() => this.emit("message", { id: msg.id, error: { code: -1, message: m } }));
    switch (msg.method) {
      case "Target.getTargets":
        reply({ targetInfos: [{ targetId: "T-1", type: "page", url: "https://vercel.com/app" }] });
        return;
      case "Target.attachToTarget":
        reply({ sessionId: "S-1" });
        return;
      case "Target.detachFromTarget":
        reply({});
        return;
      case "Runtime.evaluate": {
        const expr = String(msg.params?.["expression"] ?? "");
        if (this.scanThrows) { fail("evaluate boom"); return; }
        // The absence scan calls the embedded fn with the secret; observeText embeds the needle.
        if (expr.includes("scanDoc") || expr.includes("__ABSENCE__")) {
          reply({ result: { value: this.scanValue } });
        } else {
          reply({ result: { value: this.observeValue } });
        }
        return;
      }
      default:
        reply({});
        return;
    }
  }
}

test("proveAbsence passes when every page scans clean and conclusive", async () => {
  const t = new ScriptedTransport();
  t.scanValue = { found: false, inconclusive: false };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: true });
});

test("proveAbsence fails closed when the secret is present", async () => {
  const t = new ScriptedTransport();
  t.scanValue = { found: true, inconclusive: false };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: false });
});

test("proveAbsence fails closed on an inconclusive surface (cross-origin/inaccessible frame)", async () => {
  const t = new ScriptedTransport();
  t.scanValue = { found: false, inconclusive: true };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: false });
});

test("proveAbsence fails closed on any evaluate/CDP error", async () => {
  const t = new ScriptedTransport();
  t.scanThrows = true;
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: false });
});

test("proveAbsence fails closed on an empty secret", async () => {
  const ops = new CdpBrowserOps(new CdpClient(new ScriptedTransport()));
  assert.deepEqual(await ops.proveAbsence(""), { passed: false });
});

test("observeText returns true when the marker is in innerText on the bound domain", async () => {
  const t = new ScriptedTransport();
  t.observeValue = { host: "vercel.com", has: true };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(await ops.observeText("vercel.com", "Added", 1_000), true);
});

test("observeText returns false (no throw) when the marker never appears before timeout", async () => {
  const t = new ScriptedTransport();
  t.observeValue = { host: "vercel.com", has: false };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(await ops.observeText("vercel.com", "Added", 300), false);
});

test("observeText ignores matches on a different host", async () => {
  const t = new ScriptedTransport();
  t.observeValue = { host: "evil.example.com", has: true };
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(await ops.observeText("vercel.com", "Added", 300), false);
});

test("observeText honors the success-wait budget even when CDP hangs (not the 10s per-call default)", async () => {
  // getTargets/attach answer; Runtime.evaluate never replies. With the DEFAULT
  // 10s per-call cap, a naive bound would block ~10s on the first evaluate.
  // The remaining-budget cap must make a 400ms success-wait return ~promptly.
  class HangEvalTransport extends EventEmitter implements CdpTransport {
    send(msg: Sent): void {
      if (msg.method === "Target.getTargets") {
        queueMicrotask(() => this.emit("message", { id: msg.id, result: { targetInfos: [{ targetId: "T-1", type: "page" }] } }));
        return;
      }
      if (msg.method === "Target.attachToTarget") {
        queueMicrotask(() => this.emit("message", { id: msg.id, result: { sessionId: "S-1" } }));
        return;
      }
      // Runtime.evaluate / detach: never reply.
    }
  }
  const ops = new CdpBrowserOps(new CdpClient(new HangEvalTransport())); // default cdpCallTimeoutMs = 10_000
  const started = Date.now();
  assert.equal(await ops.observeText("vercel.com", "Added", 400), false);
  assert.ok(Date.now() - started < 3_000, "must respect the ~400ms success-wait, not the 10s per-call cap");
});

test("proveAbsence fails closed PROMPTLY when a CDP call never responds (no route hang)", async () => {
  // A transport that answers getTargets/attach but never replies to Runtime.evaluate
  // would hang forever without a bounded send. proveAbsence MUST fail closed within
  // the per-call bound so the route returns submitted:"unknown" (blind stays active)
  // instead of hanging the HTTP request indefinitely (§5.3 timeout ⇒ inconclusive).
  class DeadTransport extends EventEmitter implements CdpTransport {
    send(msg: Sent): void {
      if (msg.method === "Target.getTargets") {
        queueMicrotask(() => this.emit("message", { id: msg.id, result: { targetInfos: [{ targetId: "T-1", type: "page" }] } }));
        return;
      }
      if (msg.method === "Target.attachToTarget") {
        queueMicrotask(() => this.emit("message", { id: msg.id, result: { sessionId: "S-1" } }));
        return;
      }
      // Runtime.evaluate / detach: never reply → would hang forever unbounded.
    }
  }
  const t = new DeadTransport();
  const ops = new CdpBrowserOps(new CdpClient(t), 150); // 150ms per-CDP-call bound
  const started = Date.now();
  assert.deepEqual(await ops.proveAbsence("whsec_secret"), { passed: false });
  assert.ok(Date.now() - started < 2_000, "must fail closed promptly, not hang on the dead call");
});

// Run the real in-page ABSENCE_SCAN_FN against a DOM shim (Phase-1
// normalize-to-actionable.test.ts precedent) so the readyState guard is proven
// to apply PER scanned document, not merely to exist in the function string.
function runScan(doc: unknown, secret = "sek"): { found?: boolean; inconclusive?: boolean } {
  const make = new Function("document", `return (${ABSENCE_SCAN_FN});`) as
    (d: unknown) => (s: string) => { found?: boolean; inconclusive?: boolean };
  return make(doc)(secret);
}
function cleanDoc(readyState: string, frames: unknown[] = []): unknown {
  return {
    readyState,
    defaultView: { location: { href: "", search: "", hash: "" } },
    documentElement: { tagName: "HTML", children: [], attributes: null, shadowRoot: null },
    body: { innerText: "" },
    querySelectorAll: () => frames,
  };
}

test("absence scan is conclusive-clean when the top document AND every frame are complete", () => {
  assert.deepEqual(runScan(cleanDoc("complete")), { found: false, inconclusive: false });
});

test("absence scan fails closed when the TOP document is still loading", () => {
  assert.deepEqual(runScan(cleanDoc("loading")), { found: false, inconclusive: true });
});

test("absence scan fails closed when a SAME-ORIGIN FRAME is still loading (per-document guard)", () => {
  const loadingFrame = { contentDocument: cleanDoc("loading") };
  assert.deepEqual(runScan(cleanDoc("complete", [loadingFrame])), { found: false, inconclusive: true });
});

// --- Real ABSENCE_SCAN_FN hit-detection coverage (no stub) -------------------
// Sibling builder to cleanDoc: a single complete document whose documentElement
// subtree, body.innerText, documentElement.textContent, location and frames are
// each independently populable so a test can plant "sek" on exactly one surface
// and assert the REAL scan returns a positive (top-doc hit ⇒ {found:true}).
interface ShimNode {
  tagName?: string;
  attributes?: { name: string; value: string }[] | null;
  value?: string;
  textContent?: string;
  isContentEditable?: boolean;
  innerText?: string;
  shadowRoot?: { children: ShimNode[] } | null;
  content?: { textContent?: string } | null;
  children?: ShimNode[];
}
interface RichOpts {
  children?: ShimNode[];
  bodyInnerText?: string;
  docElementTextContent?: string;
  location?: { href?: string; search?: string; hash?: string };
  frames?: unknown[];
}
function richDoc(o: RichOpts = {}): unknown {
  return {
    readyState: "complete",
    defaultView: { location: { href: "", search: "", hash: "", ...(o.location ?? {}) } },
    documentElement: {
      tagName: "HTML",
      attributes: null,
      shadowRoot: null,
      children: o.children ?? [],
      textContent: o.docElementTextContent ?? "",
    },
    body: { innerText: o.bodyInnerText ?? "" },
    querySelectorAll: () => o.frames ?? [],
  };
}

test("absence scan hits on an allowlisted element attribute (data-*)", () => {
  const doc = richDoc({
    children: [{ tagName: "DIV", attributes: [{ name: "data-x", value: "abc-sek-xyz" }], children: [], shadowRoot: null }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

test("absence scan hits on an INPUT .value", () => {
  const doc = richDoc({
    children: [{ tagName: "INPUT", value: "pre sek post", attributes: null, children: [], shadowRoot: null }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

test("absence scan hits on a TEXTAREA .value", () => {
  const doc = richDoc({
    children: [{ tagName: "TEXTAREA", value: "line\nsek\nline", attributes: null, children: [], shadowRoot: null }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

test("absence scan hits on an open shadowRoot descendant", () => {
  const doc = richDoc({
    children: [{
      tagName: "MY-HOST",
      attributes: null,
      children: [],
      shadowRoot: { children: [{ tagName: "INPUT", value: "shadow sek here", attributes: null, children: [], shadowRoot: null }] },
    }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

test("absence scan hits on location.href", () => {
  assert.deepEqual(runScan(richDoc({ location: { href: "https://x.test/?t=sek" } })), { found: true, inconclusive: false });
});

test("absence scan hits on location.search", () => {
  assert.deepEqual(runScan(richDoc({ location: { search: "?token=sek" } })), { found: true, inconclusive: false });
});

test("absence scan hits on location.hash", () => {
  assert.deepEqual(runScan(richDoc({ location: { hash: "#sek" } })), { found: true, inconclusive: false });
});

test("absence scan hits on rendered text via body.innerText", () => {
  assert.deepEqual(runScan(richDoc({ bodyInnerText: "visible sek text" })), { found: true, inconclusive: false });
});

test("absence scan hits inside a same-origin frame's contentDocument", () => {
  const frameDoc = richDoc({
    children: [{ tagName: "INPUT", value: "in-frame sek", attributes: null, children: [], shadowRoot: null }],
  });
  const parent = richDoc({ frames: [{ contentDocument: frameDoc }] });
  assert.deepEqual(runScan(parent), { found: true, inconclusive: false });
});

// (g) THE FAIL-OPEN REGRESSION TEST: a <script type="application/json"> SSR
// hydration blob whose .textContent holds the raw secret. FAILS before the
// internal-ops change (script-readable non-rendered text was unscanned), PASSES
// after.
test("absence scan hits on a <script type=application/json> textContent (SSR hydration blob) [regression: fail-OPEN]", () => {
  const doc = richDoc({
    children: [{
      tagName: "SCRIPT",
      attributes: [{ name: "type", value: "application/json" }],
      textContent: '{"props":{"token":"sek"}}',
      children: [],
      shadowRoot: null,
    }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

// (h) display:none / non-rendered light-DOM text: present ONLY in
// documentElement.textContent, absent from body.innerText.
test("absence scan hits on non-rendered light-DOM text (documentElement.textContent superset, not body.innerText)", () => {
  const doc = richDoc({ bodyInnerText: "nothing here", docElementTextContent: "hidden sek node" });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

// (i) a <template> whose .content.textContent holds the secret (inert subtree,
// not in documentElement.textContent / body.innerText).
test("absence scan hits on a <template> content.textContent", () => {
  const doc = richDoc({
    children: [{ tagName: "TEMPLATE", attributes: null, content: { textContent: "tmpl sek" }, children: [], shadowRoot: null }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});
