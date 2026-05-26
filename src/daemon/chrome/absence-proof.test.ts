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

  close(): void { /* no-op */ }

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
    close(): void { /* no-op */ }
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
    close(): void { /* no-op */ }
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
  // Mirrors real DOM: an open shadowRoot exposes .textContent (concatenated
  // subtree text — the analog of light-DOM documentElement.textContent), the
  // SUPERSET .innerHTML (serialized subtree markup — includes comments and any
  // non-element nodes at any depth in the shadow tree), AND .children (element
  // children, walked for INPUT.value / nested hosts). Closed shadow roots are
  // null here (correctly out of scope per §5.4).
  //
  // §6.1 round-6: ABSENCE_SCAN_FN now reads `shadowRoot.innerHTML` (not
  // `.textContent`). innerHTML SUPERSETS textContent — `textContent ⊂
  // innerHTML` — so the haystack strictly grows: strictly more conservative.
  // Pre-existing round-5 tests pass `innerHTML` mirroring `textContent` (real
  // DOM: a plain text node serializes to its data in innerHTML).
  shadowRoot?: { textContent?: string; innerHTML?: string; children: ShimNode[] } | null;
  // §6.1 round-9: <template>.content is a script-readable DocumentFragment.
  // Pre-round-9 the shim only modeled `.textContent` (concatenated subtree
  // text). Round-9 closes the BOTH-gates fail-OPEN where a captured value
  // lived in a template-content descendant attribute (DFS never entered) or
  // a template-content comment (textContent excludes comments). Symmetric
  // with the shadow shape: `.textContent` (raw subtree text), `.innerHTML`
  // (serialized markup — includes comments at any depth), and `.children`
  // (element children, walked for per-element attribute/value/text checks).
  // Pre-existing test (i) only set `.textContent`; the new optional fields
  // default to undefined → fn's `typeof === "string"` guard short-circuits.
  content?: { textContent?: string; innerHTML?: string; children?: ShimNode[] } | null;
  // §6.1 round-9: the template ELEMENT's `innerHTML` (a property on the host
  // element distinct from `content.innerHTML`) serializes the fragment. Real
  // DOM: <template>.innerHTML === the serialized content. ABSENCE_SCAN_FN
  // reads `el.innerHTML` on the template host alongside `el.content
  // .textContent`. Non-template ShimNodes leave this undefined.
  innerHTML?: string;
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

// --- Open-shadow-root ORDINARY-TEXT fail-OPEN regression coverage -----------
// Open shadow roots are script-readable (incl. by the resumed agent via
// host.shadowRoot.textContent). The per-element walk only catches INPUT/TEXTAREA
// .value, contenteditable, SCRIPT/STYLE/NOSCRIPT/TEMPLATE — NOT ordinary
// spans/divs/text-nodes. The light-DOM body.innerText / documentElement.text
// Content catch-alls do NOT cross into shadow trees. So the secret as plain
// shadow text was a confirmed fail-OPEN (scan returned {found:false}). The fix
// adds shadowRoot.textContent as the in-shadow analog of the light-DOM
// documentElement.textContent catch-all. These tests model shadowRoot with BOTH
// .textContent (concatenated subtree text, like real DOM) and .children.

// (j) THE FAIL-OPEN REGRESSION GUARD: secret as ordinary text in an open-shadow
// <span> with NO value/attribute of its own. Reachable only via
// shadowRoot.textContent. FAILS before the internal-ops fix, PASSES after.
test("absence scan hits on ordinary text in an open-shadow <span> [regression: fail-OPEN]", () => {
  const doc = richDoc({
    children: [{
      tagName: "MY-HOST",
      attributes: null,
      children: [],
      shadowRoot: {
        textContent: "prefix sek suffix",
        // round-6: ABSENCE_SCAN_FN reads .innerHTML (superset of .textContent).
        // For plain text, innerHTML matches the textContent (a text node
        // serializes to its data); supplying both keeps this regression guard
        // passing across the round-5 → round-6 switch.
        innerHTML: "<span>prefix sek suffix</span>",
        children: [{ tagName: "SPAN", attributes: null, textContent: "prefix sek suffix", children: [], shadowRoot: null }],
      },
    }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

// (k) secret only as a bare text node / <div> in the shadow root: reachable via
// shadowRoot.textContent but NOT via any pushed child's per-element check
// (children empty — no INPUT/TEXTAREA/contenteditable/etc.).
test("absence scan hits on a bare text node in an open shadow root (textContent, zero scannable children)", () => {
  const doc = richDoc({
    children: [{
      tagName: "MY-HOST",
      attributes: null,
      children: [],
      // round-6: innerHTML serializes the bare text node identically to
      // textContent for plain text — providing both keeps the round-5 guard
      // passing across the round-6 switch (.textContent → .innerHTML).
      shadowRoot: { textContent: "lone sek text node", innerHTML: "lone sek text node", children: [] },
    }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

// (l) NESTED: host -> open shadowRoot -> child host -> open shadowRoot whose
// textContent holds the secret. Proves recursion still works: the outer
// shadowRoot.children push reaches the inner host, whose shadowRoot.textContent
// catch-all then fires. Outer shadow textContent itself is innocuous.
test("absence scan hits on a NESTED open-shadow textContent (host -> shadow -> host -> shadow)", () => {
  const doc = richDoc({
    children: [{
      tagName: "OUTER-HOST",
      attributes: null,
      children: [],
      shadowRoot: {
        // round-6: innerHTML supersets textContent. The outer wrapper
        // serializes as the inner host's tag (an element); the inner host's
        // shadow text plants the secret.
        textContent: "outer wrapper, nothing here",
        innerHTML: "<inner-host></inner-host>",
        children: [{
          tagName: "INNER-HOST",
          attributes: null,
          children: [],
          shadowRoot: { textContent: "deeply nested sek value", innerHTML: "deeply nested sek value", children: [] },
        }],
      },
    }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

// (m) MONOTONICITY: a CLEAN open-shadow doc (innocuous shadow text + child,
// secret nowhere) must STILL be conclusive-clean — the fix must not introduce a
// false positive.
test("absence scan stays conclusive-clean for an open shadow root with no secret (no false positive)", () => {
  const doc = richDoc({
    children: [{
      tagName: "MY-HOST",
      attributes: null,
      children: [],
      shadowRoot: {
        textContent: "perfectly innocuous shadow content",
        // round-6: innerHTML must also be innocuous to preserve the
        // monotonicity assertion (no false positive after the .textContent →
        // .innerHTML switch).
        innerHTML: "<span>innocuous</span>",
        children: [{ tagName: "SPAN", attributes: null, textContent: "innocuous", children: [], shadowRoot: null }],
      },
    }],
  });
  assert.deepEqual(runScan(doc), { found: false, inconclusive: false });
});

// --- §6.1 round-6: open-shadow COMMENT-NODE fail-OPEN regression coverage ---
// Round-5 closed plain text in an open shadowRoot via shadowRoot.textContent.
// Round-6 closes the SHADOW-COMMENT-NODE case symmetrically with BASELINE_SCAN_FN
// by switching from .textContent to .innerHTML — textContent excludes comment
// nodes, but they ARE script-readable via host.shadowRoot.innerHTML /
// host.shadowRoot.childNodes[*].data. innerHTML SUPERSETS textContent —
// `textContent ⊂ innerHTML` — so the haystack strictly grows: more fail-closed.

// (n) THE FAIL-OPEN REGRESSION GUARD: secret as a comment node directly under
// an open shadowRoot, with NO scannable children and NO matching textContent.
// Reachable only via shadowRoot.innerHTML. FAILS before the round-6
// internal-ops fix, PASSES after.
test("absence scan hits on a shadow-comment-only direct child of an open shadowRoot [regression: fail-OPEN, §6.1 round-6 symmetric with BASELINE]", () => {
  const doc = richDoc({
    children: [{
      tagName: "MY-HOST",
      attributes: null,
      children: [],
      shadowRoot: {
        // textContent EXCLUDES comment nodes — empty, so the round-5 fold
        // misses the secret. innerHTML serializes the comment, so the round-6
        // fold catches it.
        textContent: "",
        innerHTML: "<!-- sek -->",
        children: [],
      },
    }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

// --- §6.1 round-7: open-shadow ESCAPABLE-CHAR TEXT-NODE fail-OPEN guard -----
// Round-6 swapped ABSENCE's haystack from `shadowRoot.textContent` to
// `shadowRoot.innerHTML` on the node-coverage monotonicity argument
// (`textContent ⊂ innerHTML` at the NODE level — innerHTML adds comments and
// markup). That argument does NOT hold for RAW BYTES: innerHTML HTML-ESCAPES
// text nodes (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`),
// while the needle (the raw secret string) is unescaped. So
// `innerHTML.includes(rawSecret)` MISSES any secret with escapable characters
// — reopening round-5 for that character class.
//
// Round-7 fix: check BOTH `shadowRoot.textContent` (raw, unescaped — catches
// escapable-char text-node bytes) AND `shadowRoot.innerHTML` (catches
// comments + markup at any depth). Union of two surfaces — strictly
// monotonic, strictly more fail-closed, symmetric with BASELINE_SCAN_FN.

// (o) THE FAIL-OPEN REGRESSION GUARD: the needle ITSELF contains escapable
// chars, so it is present in textContent's raw bytes but absent from
// innerHTML's HTML-escaped serialization. This isolates the bug exactly:
// BEFORE round-7, innerHTML alone returns {found:false} (fail-OPEN). AFTER,
// textContent catches it. Symmetric with BASELINE_SCAN_FN's round-7 guard.
test("absence scan hits when the needle itself contains escapable HTML chars and is only in shadow textContent [§6.1 round-7 symmetric with BASELINE; innerHTML alone HTML-escapes and misses it]", () => {
  // Needle contains `&` and `<` — innerHTML encodes them, textContent does not.
  // innerHTML.includes(NEEDLE) is FALSE because innerHTML stores `&amp;` /
  // `&lt;` where the needle has the raw chars.
  const NEEDLE = "tok&<v";
  const ESCAPED = "tok&amp;&lt;v"; // how innerHTML would serialize the text node
  const make = new Function("document", `return (${ABSENCE_SCAN_FN});`) as
    (d: unknown) => (s: string) => { found?: boolean; inconclusive?: boolean };
  const doc = richDoc({
    children: [{
      tagName: "MY-HOST",
      attributes: null,
      children: [],
      shadowRoot: {
        textContent: NEEDLE,
        innerHTML: ESCAPED, // NEEDLE is NOT a substring of ESCAPED
        children: [],
      },
    }],
  });
  // Sanity: confirm the escaping discrepancy that motivates the fix.
  assert.equal(ESCAPED.includes(NEEDLE), false,
    "innerHTML serialization must NOT contain the raw needle — this is the bug class");
  assert.deepEqual(make(doc)(NEEDLE), { found: true, inconclusive: false });
});

// --- §6.1 round-8: NON-ALLOWLISTED ATTRIBUTE fail-OPEN regression coverage --
// BASELINE_SCAN_FN folds EVERY attribute via getAttributeNames()/getAttribute()
// into the daemon-only `observable` blob. ABSENCE_SCAN_FN previously only
// scanned an allowlist of attribute names (value/placeholder/title/aria-label/
// data-*) — so a captured value lingering in any non-allowlisted attribute
// (x-secret/custom-foo/etc.) post-hide would pass absence → auto-resume → the
// resumed agent could read it via getAttribute('x-secret'). Round-8 closes
// the asymmetry: ABSENCE scans EVERY attribute, aligning with BASELINE.
// Strictly more {hit:true} paths, strictly fewer {found:false} outcomes —
// monotonic toward fail-closed; cannot regress a previously-clean page.

// (p) THE FAIL-OPEN REGRESSION GUARD: secret in a NON-ALLOWLISTED attribute
// (x-secret) on a light-DOM element. Before the round-8 fix the allowlist
// skipped this attribute and ABSENCE returned {found:false}. After, every
// attribute is scanned and {found:true}.
test("absence scan hits on a NON-ALLOWLISTED attribute (x-secret) on a light-DOM element [regression: fail-OPEN, §6.1 round-8 symmetric with BASELINE all-attribute fold]", () => {
  const doc = richDoc({
    children: [{
      tagName: "DIV",
      attributes: [{ name: "x-secret", value: "lingering sek value" }],
      children: [],
      shadowRoot: null,
    }],
  });
  assert.deepEqual(runScan(doc), { found: true, inconclusive: false });
});

// (q) THE FAIL-OPEN REGRESSION GUARD (shadow + escapable chars): secret with
// escapable HTML chars (`&`, `<`) in a NON-ALLOWLISTED attribute (custom-attr)
// on an open-shadow-root child. Before round-8, allowlist skipped the attribute
// AND shadowRoot.innerHTML HTML-escapes the attribute value (so the union of
// textContent/innerHTML in the round-7 shadow gate also misses the raw needle).
// After, the per-element attribute walk inside the shadow descendant catches
// it via getAttribute()/.value (raw, unescaped).
test("absence scan hits when an open-shadow child has a captured value with escapable chars in a non-allowlisted attribute [§6.1 round-8 symmetric with BASELINE]", () => {
  const NEEDLE = "tok&<v";
  const ESCAPED = "tok&amp;&lt;v"; // how innerHTML would serialize attribute
  const make = new Function("document", `return (${ABSENCE_SCAN_FN});`) as
    (d: unknown) => (s: string) => { found?: boolean; inconclusive?: boolean };
  const doc = richDoc({
    children: [{
      tagName: "MY-HOST",
      attributes: null,
      children: [],
      shadowRoot: {
        // Round-7 shadow gate folds BOTH textContent and innerHTML. Both are
        // HTML-escaped here so neither contains the raw needle — proving the
        // per-element attribute walk is what catches this case.
        textContent: "",
        innerHTML: `<div custom-attr="${ESCAPED}"></div>`,
        children: [{
          tagName: "DIV",
          attributes: [{ name: "custom-attr", value: NEEDLE }],
          children: [],
          shadowRoot: null,
        }],
      },
    }],
  });
  // Sanity: confirm both shadow-gate surfaces miss the raw needle (so any
  // {found:true} must come from the per-element attribute walk).
  assert.equal(`<div custom-attr="${ESCAPED}"></div>`.includes(NEEDLE), false,
    "innerHTML serialization HTML-escapes attribute values — must not contain raw needle");
  assert.deepEqual(make(doc)(NEEDLE), { found: true, inconclusive: false });
});

// --- §6.1 round-9: <template>.content fail-OPEN regression coverage ---------
// <template> elements have a `.content` DocumentFragment holding parsed-but-
// inert children. It IS script-readable (`template.content.querySelector(...)
// .getAttribute(...)`, `template.content.firstChild.data` for comments).
// Pre-round-9 ABSENCE_SCAN_FN only checked `template.content.textContent`:
// textContent EXCLUDES comments AND attribute values. A captured value
// lingering in a template-content descendant attribute (e.g., x-secret) or
// a template-content comment would pass absence → auto-resume → resumed
// agent reads it via template.content.querySelector(...).getAttribute(...).
// Symmetric with the shadow rounds: check BOTH content.textContent (catches
// escapable-char text) AND template.innerHTML (catches comments + markup),
// then push content.children so the per-element attribute + value loops
// scan every descendant. Strictly more {hit:true} paths — monotonic toward
// fail-closed; cannot regress a previously-clean page.

// (r) THE FAIL-OPEN REGRESSION GUARD: secret in a NON-ALLOWLISTED attribute
// on a descendant of <template>.content. Before round-9 the DFS never entered
// template content → ABSENCE returned {found:false} → fail-OPEN. After: the
// DFS pushes content.children; the per-element attribute walk catches it.
test("absence scan hits on a NON-ALLOWLISTED attribute (x-secret) on a <template>.content descendant element [regression: fail-OPEN, §6.1 round-9 symmetric with BASELINE]", () => {
  const NEEDLE = "tok&<v";
  const ESCAPED = "tok&amp;&lt;v";
  const make = new Function("document", `return (${ABSENCE_SCAN_FN});`) as
    (d: unknown) => (s: string) => { found?: boolean; inconclusive?: boolean };
  const doc = richDoc({
    children: [{
      tagName: "TEMPLATE",
      attributes: null,
      children: [],
      shadowRoot: null,
      content: {
        textContent: "",                                                 // excludes attribute values
        innerHTML: `<span x-secret="${ESCAPED}"></span>`,                // HTML-encodes the attribute value
        children: [{
          tagName: "SPAN",
          attributes: [{ name: "x-secret", value: NEEDLE }],             // RAW, unescaped — caught by per-element attribute walk
          children: [],
          shadowRoot: null,
        }],
      },
      innerHTML: `<span x-secret="${ESCAPED}"></span>`,
    }],
  });
  // Sanity: confirm both template-element surfaces miss the raw needle (so any
  // {found:true} must come from the per-element attribute walk after the DFS push).
  assert.equal(`<span x-secret="${ESCAPED}"></span>`.includes(NEEDLE), false,
    "HTML-encoded template.innerHTML must NOT contain the raw needle — proves attribute walk is the path");
  assert.deepEqual(make(doc)(NEEDLE), { found: true, inconclusive: false });
});

// (s) THE FAIL-OPEN REGRESSION GUARD: secret as a comment node inside
// template.content. content.textContent excludes comments — pre-round-9
// ABSENCE missed it (returned {found:false}). Comments serialize verbatim
// into the template's innerHTML, so the round-9 fold catches them.
test("absence scan hits on a comment node inside <template>.content [regression: fail-OPEN, §6.1 round-9 symmetric with shadow-comment]", () => {
  const NEEDLE = "whsec_TEMPLATE_COMMENT_ABSENCE_round9";
  const doc = richDoc({
    children: [{
      tagName: "TEMPLATE",
      attributes: null,
      children: [],
      shadowRoot: null,
      content: {
        textContent: "",                       // excludes comments → round-5 surface misses
        innerHTML: `<!-- ${NEEDLE} -->`,       // comment serializes verbatim → round-9 catches
        children: [],
      },
      innerHTML: `<!-- ${NEEDLE} -->`,
    }],
  });
  assert.deepEqual(runScan(doc, NEEDLE), { found: true, inconclusive: false });
});
