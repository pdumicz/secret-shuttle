import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import {
  CdpBrowserOps,
  BASELINE_SCAN_FN,
  RESOLVE_SCAN_FN,
  type Baseline,
} from "./internal-ops.js";
import { ShuttleError } from "../../shared/errors.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

// ---- DOM-shim driving the REAL in-page fns (runScan precedent, absence-proof.test.ts) ----
// Minimal element shim: only the properties BASELINE_SCAN_FN / RESOLVE_SCAN_FN read.
// `__id` is a stable marker so the element-identity assertions can name the
// element RESOLVE_SCAN_FN returned (it now returns the chosen element itself —
// or null — exactly like NORMALIZE_TO_ACTIONABLE_FN returns the element/null).
interface El {
  __id?: string;
  nodeType?: number;
  tagName: string;
  type?: string;
  value?: string;
  innerText?: string;
  textContent?: string;
  isContentEditable?: boolean;
  role?: string | null;
  href?: boolean;
  children?: El[];
  shadowRoot?: { children: El[]; textContent?: string; innerHTML?: string } | null;
  /** Extra attributes beyond role/href, keyed by attribute name. Used by __attrs-aware shim. */
  __attrs?: Record<string, string>;
  /**
   * Open shadow root for the §6.1 round-5/round-6 shadow-fold tests. When set,
   * the shim's `shadowRoot` is this object (mirrors a real open shadowRoot:
   * script-readable `.textContent` + script-readable `.innerHTML` (which
   * SUPERSETS textContent — includes comments and any non-element nodes at any
   * depth in the shadow tree) + element `.children`). Omitted → `shadowRoot`
   * stays `null` (closed/no shadow), preserving every pre-existing test.
   *
   * `innerHTML` is optional in the shape: callers that only need the round-5
   * textContent fold may omit it (BASELINE_SCAN_FN reads `innerHTML` after the
   * round-6 fix; `undefined` is non-string and the fn's `typeof === "string"`
   * guard short-circuits cleanly — strictly monotonic).
   */
  __shadow?: { children: El[]; textContent: string; innerHTML?: string };
}
// Minimal outerHTML serializer for the shim: <TAG attr="v">children/text</TAG>
function serializeOuterHTML(e: El): string {
  const tag = e.tagName.toLowerCase();
  const attrParts: string[] = [];
  if (e.role != null) attrParts.push(`role="${e.role}"`);
  if (e.href === true) attrParts.push(`href=""`);
  if (e.__attrs !== undefined) {
    for (const [k, v] of Object.entries(e.__attrs)) {
      attrParts.push(`${k}="${String(v).replace(/"/g, "&quot;")}"`);
    }
  }
  const openTag = attrParts.length > 0 ? `<${tag} ${attrParts.join(" ")}>` : `<${tag}>`;
  const children = e.children ?? [];
  if (children.length > 0) {
    return `${openTag}${children.map(serializeOuterHTML).join("")}</${tag}>`;
  }
  const text = e.textContent ?? "";
  return `${openTag}${text}</${tag}>`;
}
function el(tag: string, props: Partial<El> = {}): El {
  const obj: El = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    children: [],
    // §6.1 round-5: an open shadowRoot is script-readable. `__shadow` opts a
    // host into one; omitted → null (closed/no shadow), exactly as before so
    // every pre-existing test is byte-unchanged.
    shadowRoot: props.__shadow ?? null,
    getAttribute(name: string) {
      if (name === "role") return props.role ?? null;
      if (props.__attrs !== undefined && name in props.__attrs) return props.__attrs[name] ?? null;
      return null;
    },
    getAttributeNames() {
      const names: string[] = [];
      if (props.role != null) names.push("role");
      if (props.href === true) names.push("href");
      if (props.__attrs !== undefined) names.push(...Object.keys(props.__attrs));
      return names;
    },
    hasAttribute(name: string) {
      if (name === "href") return props.href === true;
      if (props.__attrs !== undefined) return name in props.__attrs;
      return false;
    },
    ...props,
  } as unknown as El;
  // Attach outerHTML as a getter so it serializes the current state.
  Object.defineProperty(obj, "outerHTML", {
    get() { return serializeOuterHTML(this as El); },
    enumerable: false,
    configurable: true,
  });
  return obj;
}
function makeBaseline(root: El): (r: El) => unknown {
  return new Function("root", `return (${BASELINE_SCAN_FN}).call(root);`) as (r: El) => unknown;
}
// RESOLVE_SCAN_FN returns the chosen ELEMENT itself, or null for every
// fail-closed selection outcome (zero / >1 transition-eligible /
// already-readable-unchanged / no-transition / predicate-fails /
// focused-non-candidate). No value, no {ok,...} envelope — mirrors the
// NORMALIZE_TO_ACTIONABLE_FN element-or-null contract.
function makeResolve(root: El): (r: El, baseline: unknown, focused: El | null) => El | null {
  return new Function("root", "baseline", "focused", `return (${RESOLVE_SCAN_FN}).call(root, baseline, focused);`) as
    (r: El, b: unknown, f: El | null) => El | null;
}

test("BASELINE_SCAN_FN classes an empty/absent input as safe and a non-empty text node as readable; entries/readableFps carry no raw text (observable is daemon-only)", () => {
  const input = el("input", { type: "text", value: "" });
  const label = el("span", { textContent: "Webhook signing secret" });
  const root = el("div", { children: [input, label] });
  const b = makeBaseline(root)(root) as Baseline;
  assert.equal(Array.isArray(b.entries), true);
  // empty input → safe; label with text → readable; entries and readableFps carry no raw text.
  // observable is daemon-only and intentionally contains raw text — check only entries/readableFps.
  const safeDump = JSON.stringify({ entries: b.entries, readableFps: b.readableFps });
  assert.equal(safeDump.includes("Webhook signing secret"), false);
  const safes = b.entries.filter((e) => e.safety === "safe").length;
  const readables = b.entries.filter((e) => e.safety === "readable").length;
  assert.equal(safes >= 1, true);
  assert.equal(readables >= 1, true);
});

test("RESOLVE_SCAN_FN: a container with readable label/help siblings PLUS one revealed field returns THAT element (siblings dropped before the exactly-one check)", () => {
  // baseline: input empty (safe), label has text (readable)
  const input0 = el("input", { __id: "f1", type: "text", value: "" });
  const label = el("span", { __id: "l1", textContent: "Signing secret" });
  const help = el("p", { __id: "h1", textContent: "Click reveal to view" });
  const root0 = el("div", { children: [input0, label, help] });
  const baseline = makeBaseline(root0)(root0);
  // post-reveal: SAME structural positions; input now has the secret value
  const input1 = el("input", { __id: "f1", type: "text", value: "whsec_REVEALED" });
  const label1 = el("span", { __id: "l1", textContent: "Signing secret" });
  const help1 = el("p", { __id: "h1", textContent: "Click reveal to view" });
  const root1 = el("div", { children: [input1, label1, help1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "f1"); // the single safe→revealed element itself
});

test("RESOLVE_SCAN_FN: two simultaneously revealed fields → ambiguous → null", () => {
  const a0 = el("input", { __id: "a", type: "text", value: "" });
  const b0 = el("input", { __id: "b", type: "text", value: "" });
  const root0 = el("div", { children: [a0, b0] });
  const baseline = makeBaseline(root0)(root0);
  const a1 = el("input", { __id: "a", type: "text", value: "whsec_AAA" });
  const b1 = el("input", { __id: "b", type: "text", value: "whsec_BBB" });
  const root1 = el("div", { children: [a1, b1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN: a chosen candidate already readable-unchanged pre-reveal → fail closed → null", () => {
  const code0 = el("code", { __id: "c", textContent: "whsec_ALREADY_VISIBLE" });
  const root0 = el("div", { children: [code0] });
  const baseline = makeBaseline(root0)(root0);
  const code1 = el("code", { __id: "c", textContent: "whsec_ALREADY_VISIBLE" }); // unchanged
  const root1 = el("div", { children: [code1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN: no safe→revealed transition (stale/label text only) → fail closed → null", () => {
  const label0 = el("span", { __id: "l", textContent: "Signing secret" });
  const root0 = el("div", { children: [label0] });
  const baseline = makeBaseline(root0)(root0);
  const label1 = el("span", { __id: "l", textContent: "Signing secret" }); // unchanged readable, not a candidate transition
  const root1 = el("div", { children: [label1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN predicate rejects a button/link/label even if it has revealed text → null", () => {
  const btn0 = el("button", { __id: "btn", textContent: "" });
  const root0 = el("div", { children: [btn0] });
  const baseline = makeBaseline(root0)(root0);
  const btn1 = el("button", { __id: "btn", textContent: "whsec_LOOKS_LIKE_SECRET" }); // a button is never a candidate
  const root1 = el("div", { children: [btn1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN focused-after-reveal: focus left on a button → fail closed → null (focused arg is not a candidate)", () => {
  const btn0 = el("button", { __id: "btn", textContent: "Reveal" });
  const root0 = el("div", { children: [btn0] });
  const baseline = makeBaseline(root0)(root0);
  const btn1 = el("button", { __id: "btn", textContent: "Reveal" });
  const root1 = el("div", { children: [btn1] });
  // focused === the reveal button → not a secret-holder candidate
  const r = makeResolve(root1)(root1, baseline, btn1);
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN field-mode gate: a field scanned as its OWN root that was safe pre-reveal and is now revealed returns that element", () => {
  // field mode binds the scan to the field element itself (its own subtree
  // root); the same per-candidate safe→revealed gate applies (spec §6.1).
  const field0 = el("input", { __id: "the-field", type: "password", value: "" }); // safe baseline
  const baseline = makeBaseline(field0)(field0);
  const field1 = el("input", { __id: "the-field", type: "password", value: "whsec_UNMASKED" });
  const r = makeResolve(field1)(field1, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "the-field");
});

test("RESOLVE_SCAN_FN field-mode gate: a field already readable-unchanged pre-reveal → fail closed → null (secret was observable without blind protection)", () => {
  const field0 = el("input", { __id: "the-field", type: "text", value: "whsec_ALREADY_IN_DOM" }); // readable baseline
  const baseline = makeBaseline(field0)(field0);
  const field1 = el("input", { __id: "the-field", type: "text", value: "whsec_ALREADY_IN_DOM" }); // unchanged
  const r = makeResolve(field1)(field1, baseline, null);
  assert.equal(r, null);
});

// ---- ScriptedTransport for the CdpBrowserOps methods (absence-proof.test.ts precedent) ----
// Shapes the EXACT new CDP sequence (mirrors how mark-pick / click-backend-node
// scripted tests shape DOM.resolveNode / Runtime.callFunctionOn / DOM.describeNode):
//   resolveWithinContainer:
//     DOM.resolveNode {backendNodeId}            -> { object:{objectId} }   (the container/field root)
//     [focused-after-reveal only] Runtime.evaluate document.activeElement -> RemoteObject
//     Runtime.callFunctionOn RESOLVE_SCAN_FN  (NO returnByValue)           -> RemoteObject of the chosen element (or subtype:"null")
//     DOM.describeNode {objectId}                -> { node:{ backendNodeId } }   (chosen backend node)
//     isDescendantOf: DOM.resolveNode ×2 + Runtime.callFunctionOn `contains` -> { result:{ value:boolean } }
//     Runtime.callFunctionOn value-reader (returnByValue:true)             -> { result:{ value: "<secret>" } }   (read ONCE)
//   readBackendNodeValue: DOM.resolveNode + Runtime.callFunctionOn value-reader.
//   baselineCandidates:   DOM.resolveNode + Runtime.callFunctionOn BASELINE_SCAN_FN (returnByValue:true).
class RcTransport extends EventEmitter implements CdpTransport {
  // readBackendNodeValue / the one-shot value read in resolveWithinContainer.
  fieldValue = "whsec_FIELD_MODE_VALUE";
  // baselineCandidates drives BASELINE_SCAN_FN whose result we inject directly
  // (the scan logic itself is covered by the DOM-shim tests above).
  baselineResult: { ok: boolean; entries: Baseline["entries"]; readableFps: string[]; observable: string } = { ok: true, entries: [{ key: "k0", safety: "safe", fp: "h0" }], readableFps: [], observable: "" };
  // RESOLVE_SCAN_FN now returns the chosen ELEMENT (no returnByValue → a
  // RemoteObject). `resolveYieldsObject:false` simulates the fail-closed
  // null/no-objectId outcome (zero / >1 / already-readable / no-transition).
  resolveYieldsObject = true;
  chosenBackendNodeId = 42;
  containsResult = true;
  throwOnEvaluate = false;

  send(msg: Sent): void {
    const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    const fail = (m: string): void => queueMicrotask(() => this.emit("message", { id: msg.id, error: { code: -1, message: m } }));
    switch (msg.method) {
      case "Target.attachToTarget": reply({ sessionId: "S-1" }); return;
      case "Target.detachFromTarget":
      case "Runtime.releaseObject": reply({}); return;
      case "DOM.resolveNode": reply({ object: { objectId: `obj-${Math.random()}` } }); return;
      case "Runtime.evaluate": reply({ result: { objectId: `ae-${Math.random()}` } }); return;
      case "DOM.describeNode": reply({ node: { backendNodeId: this.chosenBackendNodeId } }); return;
      case "Runtime.callFunctionOn": {
        if (this.throwOnEvaluate) { fail("callFunctionOn boom"); return; }
        const fn = String(msg.params?.["functionDeclaration"] ?? "");
        const byValue = msg.params?.["returnByValue"] === true;
        if (fn.includes("contains")) { reply({ result: { value: this.containsResult } }); return; }
        if (fn.includes("__BASELINE__")) { reply({ result: { value: this.baselineResult } }); return; }
        if (fn.includes("__RESOLVE__")) {
          // No returnByValue: RESOLVE_SCAN_FN yields the chosen element as a
          // RemoteObject (objectId present), or a null RemoteObject for every
          // fail-closed selection outcome.
          if (this.resolveYieldsObject) { reply({ result: { objectId: `chosen-${Math.random()}` } }); return; }
          reply({ result: { type: "object", subtype: "null", value: null } });
          return;
        }
        // The tiny value-reader (returnByValue:true) used by readBackendNodeValue
        // AND the single one-shot read in resolveWithinContainer.
        if (byValue) { reply({ result: { value: { ok: true, value: this.fieldValue } } }); return; }
        reply({ result: {} });
        return;
      }
      default: reply({}); return;
    }
  }
}

test("readBackendNodeValue returns the daemon-only field value (single-element reader, §12)", async () => {
  const t = new RcTransport();
  t.fieldValue = "whsec_FIELD_MODE_VALUE";
  const ops = new CdpBrowserOps(new CdpClient(t));
  assert.equal(
    await ops.readBackendNodeValue({ target_id: "T-1", backend_node_id: 11 }),
    "whsec_FIELD_MODE_VALUE",
  );
});

test("readBackendNodeValue fails closed (ShuttleError) on any CDP error", async () => {
  const t = new RcTransport();
  t.throwOnEvaluate = true;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.readBackendNodeValue({ target_id: "T-1", backend_node_id: 11 }),
    (e: unknown) => e instanceof ShuttleError,
  );
});

test("baselineCandidates returns the hashed/classified Baseline (no raw text leaves)", async () => {
  const t = new RcTransport();
  t.baselineResult = { ok: true, entries: [{ key: "k0", safety: "safe", fp: "h0" }, { key: "k1", safety: "readable", fp: "h1" }], readableFps: ["aabbccdd"], observable: "some observable text" };
  const ops = new CdpBrowserOps(new CdpClient(t));
  const b = await ops.baselineCandidates({ target_id: "T-1", backend_node_id: 7 });
  assert.deepEqual(b, { entries: t.baselineResult.entries, readableFps: t.baselineResult.readableFps, observable: t.baselineResult.observable });
});

test("resolveWithinContainer (container): RemoteObject chosen → describeNode → isDescendantOf passes → ONE value read", async () => {
  const t = new RcTransport();
  t.resolveYieldsObject = true;
  t.chosenBackendNodeId = 42;
  t.containsResult = true;
  t.fieldValue = "whsec_RESOLVED";
  const ops = new CdpBrowserOps(new CdpClient(t));
  const r = await ops.resolveWithinContainer(
    { target_id: "T-1", backend_node_id: 7 },
    "container",
    { entries: [{ key: "k0", safety: "safe", fp: "h0" }], readableFps: [], observable: "" },
  );
  assert.deepEqual(r, { value: "whsec_RESOLVED" });
});

test("resolveWithinContainer (field mode): same per-candidate gate path — RemoteObject → describeNode → containment (chosen is the root) → value read", async () => {
  // field mode binds the scan to the field's own backend node; the chosen
  // element IS the root, so isDescendantOf (or the IS-the-root branch) holds.
  const t = new RcTransport();
  t.resolveYieldsObject = true;
  t.chosenBackendNodeId = 7; // == ref.backend_node_id (the field is its own root)
  t.containsResult = false;  // contains(self) may be false; the IS-root branch must still pass
  t.fieldValue = "whsec_FIELD_GATED";
  const ops = new CdpBrowserOps(new CdpClient(t));
  const r = await ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "field", { entries: [], readableFps: [], observable: "" });
  assert.deepEqual(r, { value: "whsec_FIELD_GATED" });
});

test("resolveWithinContainer fails closed when RESOLVE_SCAN_FN yields a null RemoteObject (zero/>1/already-readable/no-transition)", async () => {
  const t = new RcTransport();
  t.resolveYieldsObject = false; // subtype:"null" / no objectId → no single safe→revealed candidate
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "container", { entries: [], readableFps: [], observable: "" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "reveal_no_transition",
  );
});

test("resolveWithinContainer fails closed when DOM containment proof is false (chosen node not inside the approved container)", async () => {
  const t = new RcTransport();
  t.resolveYieldsObject = true;
  t.chosenBackendNodeId = 999; // != ref.backend_node_id
  t.containsResult = false;    // container.contains(chosen) === false
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "container", { entries: [], readableFps: [], observable: "" }),
    (e: unknown) => e instanceof ShuttleError && e.code === "reveal_not_contained",
  );
});

test("resolveWithinContainer fails closed on any CDP error", async () => {
  const t = new RcTransport();
  t.throwOnEvaluate = true;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.resolveWithinContainer({ target_id: "T-1", backend_node_id: 7 }, "container", { entries: [], readableFps: [], observable: "" }),
    (e: unknown) => e instanceof ShuttleError,
  );
});

test("RESOLVE_SCAN_FN: a pre-readable secret merely re-wrapped by reveal (path shifts) fails closed — value-hash re-anchor, §6.1", () => {
  const S = "whsec_ALREADY_VISIBLE_BEFORE_BLIND";
  // baseline: label (readable) + code element with pre-existing secret (readable)
  const code0 = el("code", { __id: "secret", textContent: S });
  const label0 = el("span", { __id: "lbl", textContent: "Signing secret" });
  const root0 = el("div", { children: [label0, code0] });
  const baseline = makeBaseline(root0)(root0);
  // post-reveal: SAME unchanged code value, but now nested inside a NEW wrapper <div>
  // → the code element's path shifts (e.g. "0.1" → "0.1.0"), defeating the positional gate
  const code1 = el("code", { __id: "secret", textContent: S });
  const wrapper = el("div", { children: [code1] });
  const label1 = el("span", { __id: "lbl", textContent: "Signing secret" });
  const root1 = el("div", { children: [label1, wrapper] });
  const r = makeResolve(root1)(root1, baseline, null);
  // The secret value was already script-readable before blind protection → must fail closed
  assert.equal(r, null);
});

test("RESOLVE_SCAN_FN: legitimate password masked→revealed still returns the element (no regression from the value re-anchor)", () => {
  // baseline: password input with empty value → safe (fp is hash of "")
  const field0 = el("input", { __id: "pw", type: "password", value: "" });
  const root0 = el("div", { children: [field0] });
  const baseline = makeBaseline(root0)(root0);
  // post-reveal: real secret value now present — fp of "" ≠ fp of the revealed value
  const field1 = el("input", { __id: "pw", type: "password", value: "whsec_REAL_SECRET" });
  const root1 = el("div", { children: [field1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "pw");
});

test("RESOLVE_SCAN_FN: legitimate empty-text element→revealed at the same path still returns the element", () => {
  // baseline: <code> with empty textContent → safe (fp is hash of "")
  const code0 = el("code", { __id: "tok", textContent: "" });
  const root0 = el("div", { children: [code0] });
  const baseline = makeBaseline(root0)(root0);
  // post-reveal: real token value appears — fp of "" ≠ fp of revealed value
  const code1 = el("code", { __id: "tok", textContent: "ghp_REAL_TOKEN_HERE" });
  const root1 = el("div", { children: [code1] });
  const r = makeResolve(root1)(root1, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "tok");
});

test("RESOLVE_SCAN_FN: a readable sibling label that reflows does not block a legitimate safe→revealed field", () => {
  // baseline: readable <span> label + safe empty <input> field
  const label0 = el("span", { __id: "lbl", textContent: "API Key" }); // readable — different value from the field
  const field0 = el("input", { __id: "fld", type: "text", value: "" }); // safe
  const root0 = el("div", { children: [label0, field0] });
  const baseline = makeBaseline(root0)(root0);
  // post-reveal: label re-wrapped inside a new <div> (path shifts), field revealed
  // The label's fp (hash of "API Key") ≠ the field's revealed value's fp
  const label1 = el("span", { __id: "lbl", textContent: "API Key" });
  const wrapper = el("div", { children: [label1] });
  const field1 = el("input", { __id: "fld", type: "text", value: "sk-real-api-key-9999" });
  const root1 = el("div", { children: [wrapper, field1] });
  const r = makeResolve(root1)(root1, baseline, null);
  // The label reflow must NOT fail-close the legitimate field reveal
  assert.notEqual(r, null);
  assert.equal(r?.__id, "fld");
});

test("baselineCandidates fails closed (ShuttleError reveal_baseline_failed) when an entry is structurally malformed (daemon trust-boundary guard)", async () => {
  const t = new RcTransport();
  // ok:true but an entry violates the {key:string, safety:"safe"|"readable", fp:string} shape.
  t.baselineResult = {
    ok: true,
    entries: [{ key: "k0", safety: "safe", fp: "h0" }, { key: 123, safety: "bogus", fp: null }],
  } as unknown as RcTransport["baselineResult"];
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.baselineCandidates({ target_id: "T-1", backend_node_id: 7 }),
    (e: unknown) => e instanceof ShuttleError && e.code === "reveal_baseline_failed",
  );
});

// ---- REGRESSION TESTS: three confirmed security defects (write FIRST per TDD, must fail before fix) ----

test("RESOLVE_SCAN_FN: a value visible in a non-candidate <label> pre-reveal fails closed even though it has no baseline entry (§6.1 anywhere-observable)", () => {
  // Finding 1: label text is script-readable but not a candidate → no entry in baseline.entries.
  // Post-reveal a <code> appears with THAT SAME value. Must be fail-closed.
  const S = "whsec_VISIBLE_IN_LABEL";
  const bRoot = el("div", { children: [el("label", { __id: "L", textContent: S }), el("input", { __id: "f", type: "text", value: "" })] });
  const baseline = makeBaseline(bRoot)(bRoot);
  const postRoot = el("div", { children: [el("label", { __id: "L", textContent: S }), el("code", { __id: "post", textContent: S })] });
  const r = makeResolve(postRoot)(postRoot, baseline, null);
  assert.equal(r, null, "label-visible value must be fail-closed post-reveal (§6.1 anywhere-observable)");
});

test("RESOLVE_SCAN_FN: a value visible in a non-candidate wrapper element (children>0) pre-reveal fails closed", () => {
  // Finding 1b: a wrapper <div> with children is not a candidate (isCandidate excludes children>0),
  // so its readable text does not appear in baseline.entries. The value must still block a post-reveal <code>.
  const S = "whsec_IN_WRAPPER";
  const bRoot = el("section", { children: [
    el("div", { __id: "w", children: [el("span", { textContent: "x" })], textContent: S }),
    el("input", { __id: "f", type: "text", value: "" }),
  ] });
  const baseline = makeBaseline(bRoot)(bRoot);
  const postRoot = el("section", { children: [el("span", { textContent: "x" }), el("code", { __id: "post", textContent: S })] });
  const r = makeResolve(postRoot)(postRoot, baseline, null);
  assert.equal(r, null, "wrapper-visible value must be fail-closed post-reveal (§6.1 anywhere-observable)");
});

test("RESOLVE_SCAN_FN: a text node inside a <button> is never a candidate (control descendants excluded)", () => {
  // Finding 3: a <span> inside a <button> is currently admitted as a candidate.
  // Control-subtree descendants must never be candidates regardless of their content.
  const S = "whsec_IN_BUTTON";
  const bRoot = el("div", { children: [el("input", { __id: "f", type: "text", value: "" })] });
  const baseline = makeBaseline(bRoot)(bRoot);
  const postRoot = el("div", { children: [
    el("button", { __id: "btn", children: [el("span", { __id: "s", textContent: S })] }),
    el("input", { __id: "f", type: "text", value: "" }),
  ] });
  const r = makeResolve(postRoot)(postRoot, baseline, null);
  assert.equal(r, null, "span inside button must never be a candidate (control-descendant exclusion)");
});

test("BASELINE_SCAN_FN: readableFps includes hashes of label/button text (non-candidate readable text), entries does not include them", () => {
  // Part A: BASELINE_SCAN_FN must emit readableFps for EVERY element, not just candidates.
  const labelText = "whsec_LABEL_TEXT";
  const bRoot = el("div", { children: [
    el("label", { textContent: labelText }),
    el("button", { textContent: "Reveal" }),
    el("input", { type: "text", value: "" }),
  ] });
  const b = makeBaseline(bRoot)(bRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(Array.isArray(b.readableFps), true, "readableFps must be an array");
  // The label and button text must be hashed into readableFps.
  // h("whsec_LABEL_TEXT") via djb2 - we verify by checking it's non-empty and no raw text leaks.
  assert.equal(b.readableFps.length > 0, true, "readableFps must contain at least the label/button hashes");
  // No raw text in the serialised baseline (entries and readableFps must not contain raw text;
  // observable is daemon-only and intentionally contains raw text — exclude from this dump check).
  const dump = JSON.stringify({ ok: b.ok, entries: b.entries, readableFps: b.readableFps });
  assert.equal(dump.includes(labelText), false, "no raw label text must appear in entries/readableFps JSON");
  // entries must NOT contain the label (it's not a candidate)
  assert.equal(b.entries.some((e: unknown) => JSON.stringify(e).includes(labelText)), false);
});

// ---- CONTROL TESTS: must remain passing (no legitimate-flow regression) ----

test("CONTROL: legitimate password value:'' → revealed still returns the element (no regression from comprehensive readableFps)", () => {
  const bRoot = el("div", { children: [el("input", { __id: "pw", type: "password", value: "" })] });
  const baseline = makeBaseline(bRoot)(bRoot);
  const postRoot = el("div", { children: [el("input", { __id: "pw", type: "password", value: "whsec_REAL_SECRET" })] });
  const r = makeResolve(postRoot)(postRoot, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "pw");
});

test("CONTROL: legitimate empty <code> → revealed at the same path still returns the element", () => {
  const bRoot = el("div", { children: [el("code", { __id: "tok", textContent: "" })] });
  const baseline = makeBaseline(bRoot)(bRoot);
  const postRoot = el("div", { children: [el("code", { __id: "tok", textContent: "ghp_REAL_TOKEN_HERE" })] });
  const r = makeResolve(postRoot)(postRoot, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "tok");
});

test("CONTROL: readable sibling label beside a genuine safe→revealed field — the FIELD is still returned", () => {
  // The label is readable; its hash appears in readableFps. The revealed field value is NEW (hash not in readableFps).
  const bRoot = el("div", { children: [
    el("span", { __id: "lbl", textContent: "API Key" }),
    el("input", { __id: "fld", type: "text", value: "" }),
  ] });
  const baseline = makeBaseline(bRoot)(bRoot);
  const postRoot = el("div", { children: [
    el("span", { __id: "lbl", textContent: "API Key" }),
    el("input", { __id: "fld", type: "text", value: "sk-live-real-api-key-9999" }),
  ] });
  const r = makeResolve(postRoot)(postRoot, baseline, null);
  assert.notEqual(r, null);
  assert.equal(r?.__id, "fld");
});

// ---- NEW §6.1 round-4: BASELINE_SCAN_FN observable blob tests ----

test("BASELINE_SCAN_FN: observable contains a secret appearing as a substring of label text (round-4 defect)", () => {
  // The secret is embedded inside label text — not a candidate, not in entries.
  // It MUST appear in the observable blob so the daemon-side gate can catch it.
  const SECRET_SUB = "whsec_SUBSTRING_IN_LABEL_r4";
  const bRoot = el("div", { children: [
    el("label", { textContent: `Signing secret: ${SECRET_SUB} (keep safe)` }),
    el("input", { type: "text", value: "" }),
  ] });
  const b = makeBaseline(bRoot)(bRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(b.ok, true, "ok must be true");
  assert.ok(typeof b.observable === "string", "observable must be a string");
  assert.ok(b.observable.includes(SECRET_SUB),
    "observable must contain the substring secret from the label text");
  // observable must NOT be empty
  assert.ok(b.observable.length > 0, "observable must be non-empty");
});

test("BASELINE_SCAN_FN: observable contains a secret in a data-* attribute value (round-4 defect)", () => {
  // The secret lives only in a script-readable attribute — not in textContent or .value.
  // It MUST appear in the observable blob.
  const SECRET_ATTR = "whsec_DATA_ATTR_IN_OBSERVABLE_r4";
  const bRoot = el("div", { children: [
    el("div", { __attrs: { "data-secret": SECRET_ATTR }, textContent: "" }),
    el("input", { type: "text", value: "" }),
  ] });
  const b = makeBaseline(bRoot)(bRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(b.ok, true, "ok must be true");
  assert.ok(typeof b.observable === "string", "observable must be a string");
  assert.ok(b.observable.includes(SECRET_ATTR),
    "observable must contain the attribute value secret");
});

test("BASELINE_SCAN_FN: observable is empty string with ok:false when subtree outerHTML exceeds OBS_CAP (size-bound fail-closed)", () => {
  // A pathological DOM whose outerHTML exceeds OBS_CAP must fail closed.
  // Build a shim with a getter that returns a huge string for outerHTML.
  const hugeRoot = el("div", { children: [el("input", { type: "text", value: "" })] });
  // Override the outerHTML getter to simulate a giant subtree.
  Object.defineProperty(hugeRoot, "outerHTML", {
    get() { return "x".repeat(4_000_001); },
    configurable: true,
  });
  const b = makeBaseline(hugeRoot)(hugeRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(b.ok, false, "ok must be false (size-bound fail-closed)");
  assert.equal(b.observable, "", "observable must be empty string on ok:false");
  assert.deepEqual(b.entries, [], "entries must be [] on ok:false");
  assert.deepEqual(b.readableFps, [], "readableFps must be [] on ok:false");
});

// ---- NEW §6.1 round-5: open-shadowRoot bare-text-node observable tests ----

test("BASELINE_SCAN_FN: a secret as a bare text node directly under an open shadowRoot is folded into observable (§6.1 round-5)", () => {
  // outerHTML does NOT serialize shadow DOM and the DFS only visits shadow
  // ELEMENT children — so a secret living ONLY as a bare text node directly
  // under an open shadowRoot (no element child carries it) was absent from
  // observable and readableFps: a §6.1 fail-OPEN. host.shadowRoot.innerHTML
  // (post-round-6: superset of textContent) is script-readable, so those bytes
  // WERE observable pre-blind and MUST be folded into the daemon-only
  // observable blob.
  //
  // round-6 update: BASELINE_SCAN_FN now folds shadowRoot.innerHTML (superset
  // of textContent — includes comments and any non-element nodes at any depth).
  // For plain text, innerHTML mirrors textContent (a text node serializes to
  // its data); supplying both keeps this round-5 guard passing.
  const SECRET = "whsec_SHADOW_BARE_TEXT_NODE_r5";
  const host = el("div", {
    __shadow: {
      children: [],
      textContent: `prefix ${SECRET} suffix`,
      innerHTML: `prefix ${SECRET} suffix`,
    },
  });
  const bRoot = el("div", { children: [host, el("input", { type: "text", value: "" })] });
  const b = makeBaseline(bRoot)(bRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(b.ok, true, "ok must be true");
  assert.ok(typeof b.observable === "string", "observable must be a string");
  assert.ok(b.observable.includes(SECRET),
    "observable must contain the bare shadow text-node secret (folded shadowRoot.innerHTML)");
});

test("BASELINE_SCAN_FN: a secret in a shadow ELEMENT child is still in observable AND entries (no regression from the shadow-text fold, §6.1 round-5)", () => {
  // Pre-existing behavior: a candidate ELEMENT inside an open shadowRoot is
  // walked via the shadow-children DFS — it must still appear in entries, and
  // its text must still be in observable. The shadow-text fold is strictly
  // additive and must not disturb the shadow ELEMENT-children path.
  const SECRET = "whsec_SHADOW_ELEMENT_CHILD_r5";
  const host = el("div", {
    __shadow: { children: [el("code", { __id: "shadowcode", textContent: SECRET })], textContent: SECRET },
  });
  const bRoot = el("div", { children: [host, el("input", { type: "text", value: "" })] });
  const b = makeBaseline(bRoot)(bRoot) as {
    ok: boolean;
    entries: { key: string; safety: string; fp: string }[];
    readableFps: string[];
    observable: string;
  };
  assert.equal(b.ok, true, "ok must be true");
  assert.ok(b.observable.includes(SECRET), "observable must still contain the shadow element child text");
  // The <code> shadow ELEMENT child is a candidate reached via the shadow DFS;
  // its entry key must carry a shadow segment (".s") — proves the shadow
  // children push still produces entries exactly as before.
  const shadowEntry = b.entries.find((e) => e.key.includes(".s"));
  assert.ok(shadowEntry !== undefined, "a candidate inside the shadow root must still appear in entries (.s path)");
  assert.equal(shadowEntry?.safety, "readable", "the non-empty shadow <code> must be classed readable");
  assert.ok(b.readableFps.length > 0, "readableFps must still be populated for shadow element children");
});

test("BASELINE_SCAN_FN: an open-shadowRoot textContent that pushes obsLen over OBS_CAP fails closed (ok:false, observable:'', §6.1 round-5)", () => {
  // A pathological shadow text node whose length pushes the running obsLen
  // past OBS_CAP (4_000_000) MUST fail closed — symmetric with the outerHTML /
  // readableValue / attribute size bounds. 4_000_001 chars alone overflows.
  // NOTE round-6: BASELINE_SCAN_FN now reads `shadowRoot.innerHTML` (not
  // `.textContent`). The shim's `__shadow.innerHTML` is undefined here →
  // `typeof !== "string"` short-circuits the fold (no overflow from this host).
  // This pre-existing test therefore needs `innerHTML` to be explicitly set to
  // the same overflow string to preserve the original assertion semantics.
  const host = el("div", { __shadow: { children: [], textContent: "y".repeat(4_000_001), innerHTML: "y".repeat(4_000_001) } });
  const bRoot = el("div", { children: [host, el("input", { type: "text", value: "" })] });
  const b = makeBaseline(bRoot)(bRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(b.ok, false, "ok must be false (shadow-text size-bound fail-closed)");
  assert.equal(b.observable, "", "observable must be empty string on shadow overflow");
  assert.deepEqual(b.entries, [], "entries must be [] on ok:false");
  assert.deepEqual(b.readableFps, [], "readableFps must be [] on ok:false");
});

// ---- NEW §6.1 round-6: open-shadowRoot innerHTML (comment + text) fold ----
// Round-5 closed the bare-text-node case (shadowRoot.textContent). Round-6
// closes the comment-node case (shadowRoot.innerHTML) symmetrically with
// ABSENCE_SCAN_FN, which also switches to .innerHTML. innerHTML SUPERSETS
// textContent — `textContent ⊂ innerHTML` — so the observable blob strictly
// grows: strictly more fail-closed. The shadow-comment was script-readable
// pre-blind (host.shadowRoot.innerHTML / host.shadowRoot.childNodes[*].data)
// but textContent excludes comment nodes.

test("BASELINE_SCAN_FN: a secret as a shadow-comment-only direct child of an open shadowRoot is folded into observable (§6.1 round-6 symmetric with ABSENCE)", () => {
  // The ONLY representation of the secret is a comment node directly under the
  // open shadowRoot. textContent excludes comments → before the round-6 fix,
  // the observable blob did NOT contain the secret. After: innerHTML includes
  // `<!-- … -->`, so the secret IS folded into observable.
  const SECRET = "whsec_SHADOW_COMMENT_ONLY_r6";
  const host = el("div", {
    __shadow: {
      children: [],
      textContent: "", // textContent EXCLUDES comments — empty here
      innerHTML: `<!-- ${SECRET} -->`, // innerHTML serializes the comment node
    },
  });
  const bRoot = el("div", { children: [host, el("input", { type: "text", value: "" })] });
  const b = makeBaseline(bRoot)(bRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(b.ok, true, "ok must be true");
  assert.ok(typeof b.observable === "string", "observable must be a string");
  assert.ok(b.observable.includes(SECRET),
    "observable must contain the shadow-comment-only secret (folded shadowRoot.innerHTML)");
});

test("BASELINE_SCAN_FN: a secret as plain shadow text is still in observable after the round-6 innerHTML switch (regression: round-5 case preserved)", () => {
  // Round-5 covered plain text in an open shadowRoot via shadowRoot.textContent.
  // Round-6 switches BASELINE's fold from .textContent to .innerHTML. innerHTML
  // is a SUPERSET (textContent ⊂ innerHTML), so plain shadow text must STILL be
  // covered. This regression guard sets `innerHTML` to the same string as
  // `textContent` (mirrors real DOM where innerHTML serializes the text node).
  const SECRET = "whsec_SHADOW_PLAIN_TEXT_round6_regression";
  const host = el("div", {
    __shadow: {
      children: [],
      textContent: `prefix ${SECRET} suffix`,
      innerHTML: `prefix ${SECRET} suffix`, // real DOM: a text node serializes to its data in innerHTML
    },
  });
  const bRoot = el("div", { children: [host, el("input", { type: "text", value: "" })] });
  const b = makeBaseline(bRoot)(bRoot) as { ok: boolean; entries: unknown[]; readableFps: string[]; observable: string };
  assert.equal(b.ok, true, "ok must be true");
  assert.ok(b.observable.includes(SECRET),
    "observable must still contain plain shadow text after the round-6 innerHTML switch (textContent ⊂ innerHTML)");
});
