// src/daemon/chrome/internal-ops.ts
import { createHash } from "node:crypto";
import type { CdpClient } from "./cdp-client.js";
import { ShuttleError } from "../../shared/errors.js";
import type { ElementKind } from "../browser-handles.js";

const OBSERVATION_DISABLE_METHODS = [
  "Runtime.disable",
  "Network.disable",
  "Console.disable",
  "Log.disable",
  "Profiler.disable",
  "HeapProfiler.disable",
] as const;

/**
 * Best-effort: tells Chrome to stop emitting observation domains on every attached
 * page target.  Called when blind mode starts so that pre-enabled subscriptions
 * (Runtime.consoleAPICalled, Network.responseReceived, etc.) stop flowing even
 * for events that were registered before the blind-mode flag was set.
 */
export async function disableObservationDomains(cdp: CdpClient): Promise<void> {
  const r = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  for (const t of r.targetInfos.filter((t) => t.type === "page")) {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: t.targetId,
      flatten: true,
    });
    try {
      for (const method of OBSERVATION_DISABLE_METHODS) {
        await cdp.send(method, {}, sessionId).catch(() => undefined);
      }
      await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
}

export async function blankAllPages(cdp: CdpClient): Promise<void> {
  const r = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  const pages = r.targetInfos.filter((t) => t.type === "page");
  const failed: string[] = [];
  for (const t of pages) {
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: t.targetId, flatten: true },
      );
      try {
        const nav = await cdp.send<{ errorText?: string }>(
          "Page.navigate",
          { url: "about:blank" },
          sessionId,
        );
        if (nav.errorText !== undefined && nav.errorText !== "") {
          failed.push(t.targetId);
          continue;
        }
        const ev = await cdp.send<{ result: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression: "location.href", returnByValue: true },
          sessionId,
        );
        const href = typeof ev.result.value === "string" ? ev.result.value : "";
        if (!href.startsWith("about:blank")) {
          failed.push(t.targetId);
        }
      } finally {
        await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      }
    } catch {
      failed.push(t.targetId);
    }
  }
  if (failed.length > 0) {
    throw new ShuttleError(
      "blank_failed",
      `Could not blank ${failed.length} browser page(s); blind mode kept active.`,
    );
  }
}

export interface ElementKindMeta {
  tag: string;
  type?: string;
  role?: string;
  href?: boolean;
  editable: boolean;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "password", "email", "url", "search", "tel", "number"]);

/**
 * Single source of truth for element_kind (spec §3.3). Exactly the actionable set
 * `mark pick` normalizes to. `field` = text-entry/editable only.
 */
export function elementKind(meta: ElementKindMeta): ElementKind {
  const tag = meta.tag.toLowerCase();
  const type = (meta.type ?? "").toLowerCase();
  const role = (meta.role ?? "").toLowerCase();
  if (meta.editable && tag !== "input" && tag !== "textarea") return "field"; // contenteditable
  if (tag === "textarea") return "field";
  if (tag === "input" && TEXT_INPUT_TYPES.has(type)) return "field";
  if (tag === "button" || tag === "summary" || role === "button") return "button";
  if (tag === "input" && (type === "submit" || type === "button" || type === "image" || type === "reset")) return "button";
  if ((tag === "a" && meta.href === true) || role === "link") return "link";
  return "other";
}

export interface HandleDescriptor {
  target_id: string;
  domain: string;
  page_url_host: string;
  page_title: string;
  backend_node_id: number;
  handle_fingerprint: string;
  element_kind: ElementKind;
}

export interface BackendNodeRef {
  target_id: string;
  backend_node_id: number;
}

export interface AbsenceProofResult {
  passed: boolean;
}

export type SafetyClass = "safe" | "readable";

export interface BaselineEntry {
  /** Stable structural key of the candidate within the approved subtree (path-based, not text). */
  key: string;
  /** safe = empty/absent/password-input-with-no-script-readable-value/recognized mask; readable = any non-empty script-readable value/text. */
  safety: SafetyClass;
  /** Hashed value/state fingerprint of this candidate (NEVER raw value/text). */
  fp: string;
}

export interface Baseline {
  entries: BaselineEntry[];
  /** Hashes (djb2) of every element's own readable value anywhere in the approved subtree pre-reveal, regardless of candidacy. Used by RESOLVE_SCAN_FN to detect §6.1 anywhere-observable values. */
  readableFps: string[];
  /** DAEMON-ONLY. Concatenated pre-blind observable surface of the approved subtree (serialized HTML + every element's live readable value + every raw attribute value). Contains pre-secret bytes — MUST never be returned to the agent, audited, logged, or persisted. Used only for the §6.1 substring fail-closed check. */
  observable: string;
}

export interface FieldDescriptor {
  tag: string;
  type?: string;
  name?: string;
  id?: string;
  editable: boolean;
}

export interface CaptureResult {
  value: string;
  domain: string;
  target_id: string;
  field: FieldDescriptor;
  field_fingerprint: string;
  page_title?: string;
  page_url_host?: string;
}

export interface InjectResult {
  domain: string;
  target_id: string;
  field: FieldDescriptor;
  field_fingerprint: string;
}

export interface BrowserOps {
  readonly available: boolean;
  captureFocused(): Promise<CaptureResult>;
  captureSelection(): Promise<CaptureResult>;
  injectFocused(value: string): Promise<InjectResult>;
  readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">>;
  currentDomainAndTarget(): Promise<{ domain: string; target_id: string }>;
  markFocused(): Promise<HandleDescriptor>;
  markPick(timeoutMs: number): Promise<HandleDescriptor>;
  revalidateHandle(h: { target_id: string; domain: string; backend_node_id: number; handle_fingerprint: string; element_kind: ElementKind }): Promise<void>;
  observeText(domain: string, text: string, timeoutMs: number): Promise<boolean>;
  proveAbsence(secret: string): Promise<AbsenceProofResult>;
  injectIntoBackendNode(ref: BackendNodeRef, value: string): Promise<InjectResult>;
  clickBackendNode(ref: BackendNodeRef): Promise<void>;
  /** Daemon-only single-element value reader (spec §12). Value never returned to the agent layer. Used internally; the per-candidate safe→revealed gate lives in `resolveWithinContainer` (all 3 modes go through it). */
  readBackendNodeValue(ref: BackendNodeRef): Promise<string>;
  /** Pre-blind, daemon-only: hashed value/state + safety class per candidate in the approved subtree. Readable siblings recorded, not rejected. */
  baselineCandidates(ref: BackendNodeRef): Promise<Baseline>;
  /** Post-reveal, daemon-only. Applies the SAME §6.1 per-candidate safe→revealed gate to ALL THREE modes: predicate → transition-eligible filter (drop unchanged-from-readable / still-safe) → exactly one safe→revealed → DOM containment proof → one-shot value read. For `field` the scan is bound to the field's own backend node (the field is its own subtree root / sole candidate) so a field already readable-unchanged pre-reveal fails closed too. Throws fail-closed on any uncertainty. */
  resolveWithinContainer(ref: BackendNodeRef, mode: "field" | "container" | "focused-after-reveal", baseline: Baseline): Promise<{ value: string }>;
}

// Daemon-only focused-field/selection reader. Exported so the capture-target-ops
// module (C6) can drive the SAME in-page script under a target-bound CDP
// session — single source of truth for "what counts as a captured field/value"
// across the live-mark flow (revealCaptureCore) and the bootstrap flow.
export const READ_SCRIPT = `
(() => {
  function meta(el){
    const i = el instanceof HTMLInputElement ? el : null;
    const ta = el instanceof HTMLTextAreaElement ? el : null;
    const editable = el instanceof HTMLElement && el.isContentEditable;
    return { tag: el.tagName.toLowerCase(), type: i?.type, name: i?.name ?? ta?.name, id: el.id, editable };
  }
  const a = document.activeElement;
  const sel = window.getSelection()?.toString() ?? "";
  if (!(a instanceof Element)) return { ok:false, reason:"no_active_element" };
  const base = { field: meta(a), domain: location.hostname, title: document.title, urlHost: location.host };
  if (sel !== "") return { ok:true, value: sel, source:"selection", ...base };
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return { ok:true, value:a.value, source:"focused-field", ...base };
  if (a instanceof HTMLElement && a.isContentEditable) return { ok:true, value: a.innerText, source:"focused-field", ...base };
  return { ok:false, reason:"not_editable" };
})()
`;

const WRITE_SCRIPT = (value: string) => `
((v) => {
  function meta(el){
    const i = el instanceof HTMLInputElement ? el : null;
    const ta = el instanceof HTMLTextAreaElement ? el : null;
    const editable = el instanceof HTMLElement && el.isContentEditable;
    return { tag: el.tagName.toLowerCase(), type: i?.type, name: i?.name ?? ta?.name, id: el.id, editable };
  }
  function setNative(el, val){
    const p = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p, "value")?.set?.call(el, val);
  }
  const a = document.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) {
    a.focus(); setNative(a, v);
    a.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));
    a.dispatchEvent(new Event("change",{bubbles:true}));
    return { ok:true, field: meta(a), domain: location.hostname };
  }
  if (a instanceof HTMLElement && a.isContentEditable) {
    a.focus(); a.textContent = v;
    a.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));
    a.dispatchEvent(new Event("change",{bubbles:true}));
    return { ok:true, field: meta(a), domain: location.hostname };
  }
  return { ok:false, reason:"not_editable" };
})(${JSON.stringify(value)})
`;

const HANDLE_READ_SCRIPT = `
(() => {
  const a = document.activeElement;
  if (!(a instanceof Element)) return { ok:false, reason:"no_active_element" };
  const i = a instanceof HTMLInputElement ? a : null;
  const ta = a instanceof HTMLTextAreaElement ? a : null;
  const editable = a instanceof HTMLElement && a.isContentEditable;
  return {
    ok: true,
    meta: {
      tag: a.tagName.toLowerCase(),
      type: i ? i.type : undefined,
      name: (i && i.name) || (ta && ta.name) || undefined,
      id: a.id || undefined,
      editable,
      role: a.getAttribute("role") || undefined,
      ariaLabel: a.getAttribute("aria-label") || undefined,
      href: a.tagName.toLowerCase() === "a" ? a.hasAttribute("href") : false,
    },
    domain: location.hostname,
    title: document.title,
    urlHost: location.host,
  };
})()
`;

// In-page self→ancestor walk to the nearest actionable element. Exported so the
// climb logic (incl. the text-node start) is unit-tested directly — it runs in
// the page so it cannot import elementKind(); it MUST stay in lockstep with
// elementKind() in this file (spec §3.3 single source of truth).
export const NORMALIZE_TO_ACTIONABLE_FN = `function(){
  const TEXT = new Set(["","text","password","email","url","search","tel","number"]);
  function kind(el){
    const tag = el.tagName.toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const editable = el instanceof HTMLElement && el.isContentEditable;
    if (editable && tag !== "input" && tag !== "textarea") return "field";
    if (tag === "textarea") return "field";
    if (tag === "input" && TEXT.has(type)) return "field";
    if (tag === "button" || tag === "summary" || role === "button") return "button";
    if (tag === "input" && ["submit","button","image","reset"].includes(type)) return "button";
    if ((tag === "a" && el.hasAttribute("href")) || role === "link") return "link";
    return "other";
  }
  let el = this.nodeType === 1 ? this : this.parentElement, depth = 0;
  while (el && el.nodeType === 1 && depth < 25) {
    if (kind(el) !== "other") return el;
    el = el.parentElement;
    depth++;
  }
  return null;
}`;

// Daemon-only. Runs in the page under the daemon's internal CDP (agent severed).
// Returns ONLY booleans — never the secret, never where it was found (§5.1/§5.3).
// "__ABSENCE__" marker lets the scripted test transport route this expression.
// Exported so the navigation-uncertainty guard is unit-assertable (Phase-1 pattern).
export const ABSENCE_SCAN_FN = `function(secret){ /* __ABSENCE__ */
  try {
    if (typeof secret !== "string" || secret === "") return { found:false, inconclusive:true };
    const hit = (s) => typeof s === "string" && s.indexOf(secret) !== -1;
    function scanDoc(doc){
      // Navigation uncertainty (§5.3): a still-loading document means content
      // (incl. the secret) may not have rendered yet. Applied PER scanned
      // document so a mid-load SAME-ORIGIN frame can't be scanned as clean.
      try { if (doc.readyState !== "complete") return { inconclusive:true }; } catch (e) { return { inconclusive:true }; }
      try {
        const w = doc.defaultView, l = w && w.location;
        if (l && (hit(l.href) || hit(l.search) || hit(l.hash))) return { hit:true };
      } catch (e) { return { inconclusive:true }; }
      let n = 0;
      const stack = doc.documentElement ? [doc.documentElement] : [];
      while (stack.length) {
        const el = stack.pop();
        if (!el) continue;
        if (++n > 200000) return { inconclusive:true };
        if (el.attributes) {
          // §6.1 round-8: scan EVERY attribute value, not just an allowlist. Aligns
          // ABSENCE with BASELINE_SCAN_FN's all-attribute fold (no asymmetry: the
          // captured value lingering in any non-allowlisted attribute like x-secret/
          // custom-foo must fail the absence proof, else auto-resume would let the
          // resumed agent read it via getAttribute). Strictly more {hit:true} paths,
          // never fewer (monotonic toward fail-closed). Any throw → inconclusive.
          try {
            for (const a of el.attributes) {
              if (hit(a.value)) return { hit:true };
            }
          } catch (e) { return { inconclusive:true }; }
        }
        if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && hit(el.value)) return { hit:true };
        try { if (el.isContentEditable && hit(el.innerText)) return { hit:true }; } catch (e) {}
        if ((el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") && hit(el.textContent)) return { hit:true };
        if (el.tagName === "TEMPLATE" && el.content) {
          // §6.1 round-9: <template>.content is script-readable and inert.
          // Check BOTH raw content.textContent (catches escapable-char text)
          // AND innerHTML (catches comments + markup at any depth) — symmetric
          // with the shadow block above. Read innerHTML from BOTH the host
          // element (template.innerHTML === serialized fragment in real DOM)
          // AND content.innerHTML (DocumentFragment's own serialization) — they
          // yield the same string in real DOM, but reading both is strictly
          // monotonic and covers any environment where only one is exposed
          // (e.g., test shims). Then push content.children so the DFS continues
          // into the descendants and the R8 per-element all-attribute +
          // INPUT/TEXTAREA value + contentEditable checks catch any captured
          // value lingering inside.
          try {
            if (hit(el.content.textContent)) return { hit:true };
            if (hit(el.innerHTML)) return { hit:true };
            if (hit(el.content.innerHTML)) return { hit:true };
          } catch (e) { return { inconclusive:true }; }
          try {
            if (el.content.children) {
              for (const c of el.content.children) stack.push(c);
            }
          } catch (e) { return { inconclusive:true }; }
        }
        if (el.shadowRoot) {
          // Open shadow roots are script-readable (incl. by the resumed agent
          // via host.shadowRoot.textContent / host.shadowRoot.innerHTML /
          // host.shadowRoot.childNodes[*].data). Closed shadow roots are null
          // here → correctly out of scope per §5.4. Fail closed on any error.
          //
          // §6.1 round-7: check BOTH textContent (raw, unescaped — catches
          // escapable-char text-node bytes like & < > " that innerHTML would
          // HTML-encode) AND innerHTML (catches comments + markup at any
          // depth in the shadow tree). Symmetric with BASELINE_SCAN_FN above;
          // strictly more conservative than either alone (haystack is the
          // union of two surfaces, more {found:true} possible, never fewer).
          try {
            if (hit(el.shadowRoot.textContent)) return { hit:true };
            if (hit(el.shadowRoot.innerHTML)) return { hit:true };
          } catch (e) { return { inconclusive:true }; }
          for (const c of el.shadowRoot.children) stack.push(c);
        }
        if (el.children) { for (const c of el.children) stack.push(c); }
      }
      try { if (doc.body && hit(doc.body.innerText)) return { hit:true }; } catch (e) {}
      try { var de = doc.documentElement; if (de && hit(de.textContent)) return { hit:true }; } catch (e) { return { inconclusive:true }; }
      let frames;
      try { frames = doc.querySelectorAll("iframe,frame"); } catch (e) { return { inconclusive:true }; }
      for (const f of frames) {
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { return { inconclusive:true }; }
        if (cd === null) return { inconclusive:true };
        const r = scanDoc(cd);
        if (r.hit) return { hit:true };
        if (r.inconclusive) return { inconclusive:true };
      }
      return {};
    }
    const r = scanDoc(document);
    if (r.inconclusive) return { found:false, inconclusive:true };
    return { found: r.hit === true, inconclusive:false };
  } catch (e) { return { found:false, inconclusive:true }; }
}`;

const OBSERVE_TEXT_FN = `function(needle){
  try {
    const t = (document.body && document.body.innerText) || "";
    return { host: location.host, has: typeof needle === "string" && needle !== "" && t.indexOf(needle) !== -1 };
  } catch (e) { return { host:"", has:false }; }
}`;

// Daemon-only. `this` = the approved field/container subtree root. Records, per
// candidate-eligible element, a HASHED value/state fingerprint (never raw) + a
// safety class (§6.1). Readable siblings are RECORDED, not rejected. Returns
// { entries:[{key,safety,fp}] } only. "__BASELINE__" routes the scripted test
// transport. Exported so the predicate/classification is unit-assertable.
export const BASELINE_SCAN_FN = `function(){ /* __BASELINE__ */
  var TEXT = ["","text","password","email","url","search","tel","number"];
  var OBS_CAP = 4000000;
  function h(s){ // small non-cryptographic digest; only used to detect change (never reversed/egressed as text)
    s = String(s == null ? "" : s); var x = 5381, i = 0;
    for (i = 0; i < s.length; i++) { x = ((x << 5) + x + s.charCodeAt(i)) | 0; }
    return ("00000000" + (x >>> 0).toString(16)).slice(-8);
  }
  function kind(el){
    var tag = el.tagName.toLowerCase();
    var type = (el.type || "").toLowerCase();
    var role = (el.getAttribute && (el.getAttribute("role") || "")).toLowerCase ? (el.getAttribute("role") || "").toLowerCase() : "";
    var editable = (typeof HTMLElement !== "undefined" && el instanceof HTMLElement) ? el.isContentEditable : el.isContentEditable === true;
    if (editable && tag !== "input" && tag !== "textarea") return "field";
    if (tag === "textarea") return "field";
    if (tag === "input" && TEXT.indexOf(type) !== -1) return "field";
    if (tag === "button" || tag === "summary" || role === "button") return "button";
    if (tag === "input" && ["submit","button","image","reset"].indexOf(type) !== -1) return "button";
    if ((tag === "a" && el.hasAttribute && el.hasAttribute("href")) || role === "link") return "link";
    return "other";
  }
  // A candidate is: a field-kind element with non-empty value/text, OR a
  // non-interactive text-bearing element (code/span/pre/p/div text node) with
  // non-empty text. Buttons/links/labels are NEVER candidates.
  function isCandidate(el){
    var k = kind(el);
    if (k === "button" || k === "link") return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "label") return false;
    if (k === "field") return true;
    // non-interactive text element: only count its OWN text (no descendant elements
    // with their own candidacy) to avoid double-counting container wrappers.
    if (el.children && el.children.length > 0) return false;
    return true;
  }
  function readableValue(el){
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      // password input with no script-readable value is SAFE; .value is script-readable here only if the page exposes it
      return typeof el.value === "string" ? el.value : "";
    }
    if (el.isContentEditable) return typeof el.innerText === "string" ? el.innerText : "";
    return typeof el.textContent === "string" ? el.textContent : "";
  }
  function isSafeState(el){
    var tag = el.tagName.toLowerCase();
    var v = readableValue(el);
    if (v === "" || v == null) return true;
    if ((tag === "input" || tag === "textarea") && (el.type || "").toLowerCase() === "password" && el.value === "") return true;
    // recognized mask/placeholder: a run of bullet/asterisk chars only
    if (/^[\\u2022\\u25CF\\*\\u2024\\u00B7\\s]+$/.test(v)) return true;
    return false;
  }
  try {
    var root = this;
    if (!root || root.nodeType !== 1) return { ok:false, entries:[], readableFps:[], observable:"" };
    // §6.1 observable blob: size-bound check on outerHTML first (single property access).
    var outerHtml = "";
    try { outerHtml = root.outerHTML; } catch (e) { return { ok:false, entries:[], readableFps:[], observable:"" }; }
    if (typeof outerHtml !== "string" || outerHtml.length > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
    var obsParts = [outerHtml];
    var obsLen = outerHtml.length;
    var entries = [], readableFpsSet = {}, stack = [{ el: root, path: "0", inControl: false, inTemplate: false }], n = 0;
    while (stack.length) {
      var cur = stack.pop(); var el = cur.el;
      if (!el || el.nodeType !== 1) continue;
      if (++n > 200000) return { ok:false, entries:[], readableFps:[], observable:"" };
      // Part A: hash EVERY element's own readable value into readableFpsSet (regardless of candidacy or inControl).
      var rv = readableValue(el);
      if (rv !== "") readableFpsSet[h(rv)] = 1;
      // §6.1 observable: collect live readableValue per element (unescaped — covers input .value/contentEditable not in outerHTML).
      // Use NUL (\\x00) separator to prevent cross-boundary false matches.
      if (rv !== "") {
        obsLen += 1 + rv.length;
        if (obsLen > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
        obsParts.push(rv);
      }
      // §6.1 observable: collect every attribute value (unescaped raw attribute values — covers HTML-escaping blind spots and non-reflected attrs).
      try {
        var attrNames = el.getAttributeNames ? el.getAttributeNames() : [];
        for (var ai = 0; ai < attrNames.length; ai++) {
          var av = el.getAttribute(attrNames[ai]);
          if (typeof av === "string" && av !== "") {
            obsLen += 1 + av.length;
            if (obsLen > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
            obsParts.push(av);
          }
        }
      } catch (e) { return { ok:false, entries:[], readableFps:[], observable:"" }; }
      // Part B: an element is a candidate only if NOT inside a control subtree
      // AND not inside a <template>.content fragment (§6.1 round-9: template
      // content is inert / never rendered / never interactive — bytes still
      // fold into observable for the §6.1 reject, but they can never be the
      // chosen capture target).
      var selfControl = (kind(el) === "button" || kind(el) === "link" || el.tagName.toLowerCase() === "label");
      if (!cur.inControl && !cur.inTemplate && isCandidate(el)) {
        var safe = isSafeState(el);
        entries.push({ key: cur.path, safety: safe ? "safe" : "readable", fp: h(readableValue(el)) });
      }
      var childInControl = cur.inControl || selfControl;
      if (el.shadowRoot) {
        // §6.1: an open shadowRoot is script-readable, so anything in its
        // subtree was observable pre-blind. outerHTML does NOT serialize
        // shadow DOM and the DFS only visits shadow ELEMENT children, so we
        // must fold the shadow surface into the observable blob explicitly.
        //
        // §6.1 round-7: fold BOTH shadowRoot.textContent (RAW, unescaped —
        // catches text-node bytes with escapable chars like & < > " that
        // innerHTML would HTML-encode) AND shadowRoot.innerHTML (catches
        // comments and markup at any depth in the shadow tree). textContent
        // is NOT a raw-byte superset of innerHTML, and vice versa — they
        // cover different surfaces — so BOTH are required to fully express
        // "anything script-readable in the open shadow tree". Closes both
        // the round-5 plain-text case (unconditionally, for any character
        // class) and the round-6 shadow-comment case — symmetric with
        // ABSENCE_SCAN_FN's dual check below. Size-bounded against the same
        // running obsLen; any throw → fail closed.
        try {
          var tc = el.shadowRoot.textContent;
          if (typeof tc === "string" && tc !== "") {
            obsLen += 1 + tc.length;
            if (obsLen > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
            obsParts.push(tc);
          }
          var ih = el.shadowRoot.innerHTML;
          if (typeof ih === "string" && ih !== "") {
            obsLen += 1 + ih.length;
            if (obsLen > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
            obsParts.push(ih);
          }
        } catch (e) { return { ok:false, entries:[], readableFps:[], observable:"" }; }
        var sc = el.shadowRoot.children;
        for (var i = 0; i < sc.length; i++) stack.push({ el: sc[i], path: cur.path + ".s" + i, inControl: childInControl, inTemplate: cur.inTemplate });
      }
      // §6.1 round-9: <template>.content is a script-readable DocumentFragment
      // (reachable via template.content.querySelector(...).getAttribute(...),
      // template.content.textContent, template.content.childNodes[*].data) but
      // template.children is empty and root.outerHTML HTML-escapes its descendants'
      // text, so the DFS otherwise misses it. Fold BOTH raw content.textContent
      // (catches escapable-char text and direct text descendants) AND innerHTML
      // (catches comments + descendant element markup + attribute names) —
      // symmetric with the shadow block above. Read innerHTML from BOTH the host
      // element (template.innerHTML === serialized fragment in real DOM) AND
      // content.innerHTML (DocumentFragment's own serialization) — they yield the
      // same string in real DOM, but reading both is strictly monotonic and covers
      // any environment where only one is exposed (e.g., test shims). Size-bounded
      // against the same running obsLen; any throw → fail closed.
      if (el.tagName.toLowerCase() === "template" && el.content) {
        try {
          var ttc = el.content.textContent;
          if (typeof ttc === "string" && ttc !== "") {
            obsLen += 1 + ttc.length;
            if (obsLen > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
            obsParts.push(ttc);
          }
          var tih = el.innerHTML;
          if (typeof tih === "string" && tih !== "") {
            obsLen += 1 + tih.length;
            if (obsLen > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
            obsParts.push(tih);
          }
          var tcih = el.content.innerHTML;
          if (typeof tcih === "string" && tcih !== "") {
            obsLen += 1 + tcih.length;
            if (obsLen > OBS_CAP) return { ok:false, entries:[], readableFps:[], observable:"" };
            obsParts.push(tcih);
          }
        } catch (e) { return { ok:false, entries:[], readableFps:[], observable:"" }; }
        // Push content descendant elements so the per-element loop folds their
        // readableValue + every attribute into the blob. Mark inTemplate=true so
        // they're NEVER capture candidates (template content is inert / never
        // rendered / never interactive).
        try {
          var tc2 = el.content.children;
          if (tc2) {
            for (var ti = 0; ti < tc2.length; ti++) {
              stack.push({ el: tc2[ti], path: cur.path + ".t" + ti, inControl: cur.inControl, inTemplate: true });
            }
          }
        } catch (e) { return { ok:false, entries:[], readableFps:[], observable:"" }; }
      }
      if (el.children) { for (var j = 0; j < el.children.length; j++) stack.push({ el: el.children[j], path: cur.path + "." + j, inControl: childInControl, inTemplate: cur.inTemplate }); }
    }
    var readableFpsArr = Object.keys(readableFpsSet);
    var observable = obsParts.join("\\x00");
    return { ok:true, entries: entries, readableFps: readableFpsArr, observable: observable };
  } catch (e) { return { ok:false, entries:[], readableFps:[], observable:"" }; }
}`;

// Daemon-only. `this` = the approved subtree root: the container (modes
// `container`/`focused-after-reveal`) OR the field's own element (mode `field`,
// where the field is its own subtree root / sole candidate). `focused` is the
// document.activeElement passed in for `focused-after-reveal`, else null.
//
// Returns the CHOSEN ELEMENT ITSELF (`return chosen;`) — or `null` for EVERY
// fail-closed selection outcome (zero transition-eligible / >1
// transition-eligible / chosen-but-already-readable-unchanged / no
// safe→revealed transition / predicate-fails-or-control-label /
// focused-after-reveal with a non-candidate focused element / empty resolved
// value / any error). NO value, NO {ok,...} envelope — this exactly mirrors
// the merged NORMALIZE_TO_ACTIONABLE_FN element-or-null contract so the daemon
// (resolveWithinContainer) can take it via Runtime.callFunctionOn WITHOUT
// returnByValue (a RemoteObject), prove DOM containment with the EXISTING
// isDescendantOf, and then read the value EXACTLY ONCE off that same objectId.
// Returning the element does NOT egress text (no returnByValue → only a remote
// handle). "__RESOLVE__" routes the scripted test transport. The embedded
// kind()/predicate/transition logic is UNCHANGED (must stay in lockstep with
// elementKind()/NORMALIZE_TO_ACTIONABLE_FN, §3.3); only the returns are now
// element-or-null. The single chosen value is read separately, once, by the
// daemon (→ upsertSecret only).
export const RESOLVE_SCAN_FN = `function(baseline, focused){ /* __RESOLVE__ */
  var TEXT = ["","text","password","email","url","search","tel","number"];
  function h(s){ s = String(s == null ? "" : s); var x = 5381, i = 0; for (i=0;i<s.length;i++){ x = ((x<<5)+x+s.charCodeAt(i))|0; } return ("00000000"+(x>>>0).toString(16)).slice(-8); }
  function kind(el){
    var tag = el.tagName.toLowerCase();
    var type = (el.type || "").toLowerCase();
    var role = (el.getAttribute && (el.getAttribute("role") || "")).toLowerCase ? (el.getAttribute("role") || "").toLowerCase() : "";
    var editable = (typeof HTMLElement !== "undefined" && el instanceof HTMLElement) ? el.isContentEditable : el.isContentEditable === true;
    if (editable && tag !== "input" && tag !== "textarea") return "field";
    if (tag === "textarea") return "field";
    if (tag === "input" && TEXT.indexOf(type) !== -1) return "field";
    if (tag === "button" || tag === "summary" || role === "button") return "button";
    if (tag === "input" && ["submit","button","image","reset"].indexOf(type) !== -1) return "button";
    if ((tag === "a" && el.hasAttribute && el.hasAttribute("href")) || role === "link") return "link";
    return "other";
  }
  function isCandidate(el){
    var k = kind(el);
    if (k === "button" || k === "link") return false;
    var tag = el.tagName.toLowerCase();
    if (tag === "label") return false;
    if (k === "field") return true;
    if (el.children && el.children.length > 0) return false;
    return true;
  }
  function readableValue(el){
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return typeof el.value === "string" ? el.value : "";
    if (el.isContentEditable) return typeof el.innerText === "string" ? el.innerText : "";
    return typeof el.textContent === "string" ? el.textContent : "";
  }
  function isSafeState(el){
    var tag = el.tagName.toLowerCase();
    var v = readableValue(el);
    if (v === "" || v == null) return true;
    if ((tag === "input" || tag === "textarea") && (el.type || "").toLowerCase() === "password" && el.value === "") return true;
    if (/^[\\u2022\\u25CF\\*\\u2024\\u00B7\\s]+$/.test(v)) return true;
    return false;
  }
  try {
    var root = this;
    if (!root || root.nodeType !== 1) return null;
    var bmap = {}; var be = (baseline && baseline.entries) || [];
    for (var bi = 0; bi < be.length; bi++) bmap[be[bi].key] = be[bi];
    // Part A: build reject set from the comprehensive readableFps list (every element's readable value, not just candidate entries).
    var readableFps = {}; var rf = (baseline && baseline.readableFps) || []; for (var ri=0; ri<rf.length; ri++) readableFps[rf[ri]] = 1;
    // Enumerate predicate-matching elements with the SAME structural keys as the
    // baseline. The root itself is included (mode field: the field is its own
    // root and sole candidate, so the same per-candidate gate applies to it).
    // Part B: carry inControl so control/label subtree descendants are never candidates.
    var cands = [], stack = [{ el: root, path: "0", inControl: false }], n = 0;
    while (stack.length) {
      var cur = stack.pop(); var el = cur.el;
      if (!el || el.nodeType !== 1) continue;
      if (++n > 200000) return null;
      var selfControl = (kind(el) === "button" || kind(el) === "link" || el.tagName.toLowerCase() === "label");
      if (!cur.inControl && isCandidate(el)) cands.push({ el: el, path: cur.path });
      var childInControl = cur.inControl || selfControl;
      if (el.shadowRoot) { var sc = el.shadowRoot.children; for (var i=0;i<sc.length;i++) stack.push({ el: sc[i], path: cur.path + ".s" + i, inControl: childInControl }); }
      if (el.children) { for (var j=0;j<el.children.length;j++) stack.push({ el: el.children[j], path: cur.path + "." + j, inControl: childInControl }); }
    }
    // focused-after-reveal: the only eligible element is the passed activeElement,
    // and ONLY if it itself passes the predicate.
    if (focused != null) {
      if (!isCandidate(focused)) return null;
      cands = cands.filter(function(c){ return c.el === focused; });
      if (cands.length === 0) return null;
    }
    // Filter to TRANSITION-ELIGIBLE: had a SAFE baseline AND now shows a
    // safe→revealed transition (now NOT safe, value present). Drop anything
    // unchanged from a readable baseline or still-safe. A chosen candidate that
    // was already READABLE-UNCHANGED pre-reveal is the manual-handling case
    // (secret was observable without blind protection → fail closed → null).
    var eligible = [];
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var b = bmap[c.path];
      var nowSafe = isSafeState(c.el);
      if (b && b.safety === "readable") {
        // preexisting readable (unchanged OR changed) is NEVER a safe→revealed
        // transition → ignored (not ambiguous, not eligible).
        continue;
      }
      // b is safe (or no baseline entry → treat as newly-appeared/safe)
      if (nowSafe) continue;                     // still safe → not revealed
      if (readableFps[h(readableValue(c.el))]) continue; // §6.1: this exact value was script-readable somewhere in the approved subtree pre-reveal → observable before blind protection → fail closed. Positional baseline keys are unstable across reveal-time DOM reflow, so re-anchor the "already readable" decision by value hash, not path.
      eligible.push(c);
    }
    // Exactly-one rule over the TRANSITION-ELIGIBLE set only (readable siblings
    // never cause a false ">1"). Zero / >1 / empty value → null. Same logic as
    // before; only the return is now the element (or null).
    if (eligible.length !== 1) return null;
    var chosen = eligible[0].el;
    var val = readableValue(chosen);
    if (typeof val !== "string" || val === "") return null;
    return chosen;
  } catch (e) { return null; }
}`;

// Exported so the capture-target-ops module (C6) reuses the same seed/format
// as live-mark capture — no parallel hashing scheme, no drift.
export function fieldFingerprint(domain: string, target: string, backendNodeId: number | null, field: FieldDescriptor): string {
  const seed = JSON.stringify({ domain, target, backendNodeId, ...field });
  return `sha256:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/**
 * Handle fingerprint: extends the field fingerprint seed with role + accessible
 * name + element_kind so revalidation is anchored on more than the backend node.
 * Never stores/returns raw role/name/value — only this hash.
 */
function handleFingerprint(
  domain: string,
  target: string,
  backendNodeId: number | null,
  meta: { tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string },
  kind: ElementKind,
): string {
  const seed = JSON.stringify({ domain, target, backendNodeId, ...meta, kind });
  return `sha256:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function polygonArea(xs: number[], ys: number[]): number {
  let a = 0;
  for (let i = 0; i < xs.length; i++) {
    const j = (i + 1) % xs.length;
    a += (xs[i] ?? 0) * (ys[j] ?? 0) - (xs[j] ?? 0) * (ys[i] ?? 0);
  }
  return Math.abs(a) / 2;
}

export class CdpBrowserOps implements BrowserOps {
  available = true;
  constructor(private readonly cdp: CdpClient, private readonly cdpCallTimeoutMs = 10_000) {}

  private async pickPage(): Promise<{ id: string }> {
    const r = await this.cdp.send<{ targetInfos: { targetId: string; type: string; url: string; attached: boolean }[] }>(
      "Target.getTargets",
    );
    const page = r.targetInfos.find((t) => t.type === "page" && t.url !== "about:blank")
      ?? r.targetInfos.find((t) => t.type === "page");
    if (page === undefined) throw new Error("no_page_target");
    return { id: page.targetId };
  }

  private async attach(target: string): Promise<string> {
    const r = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target, flatten: true });
    return r.sessionId;
  }

  private async evaluate<T>(target: string, script: string): Promise<T> {
    const sessionId = await this.attach(target);
    try {
      const r = await this.cdp.send<{ result: { value: T } }>(
        "Runtime.evaluate",
        { expression: script, returnByValue: true, awaitPromise: false },
        sessionId,
      );
      return r.result.value;
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  private async getFocusedBackendNodeId(targetId: string): Promise<number | null> {
    const sessionId = await this.attach(targetId);
    try {
      const ev = await this.cdp.send<{ result: { objectId?: string; subtype?: string } }>(
        "Runtime.evaluate",
        { expression: "document.activeElement", returnByValue: false },
        sessionId,
      );
      const objectId = ev.result.objectId;
      if (objectId === undefined) return null;
      try {
        const r = await this.cdp.send<{ nodeId: number }>("DOM.requestNode", { objectId }, sessionId);
        const desc = await this.cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId: r.nodeId }, sessionId);
        return desc.node.backendNodeId;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
      }
    } catch {
      return null;
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  // Filter by sessionId — CdpClient keys listeners only by method, so without
  // this a pick on a different page target could wrongly resolve this wait.
  // Returns a cancelable handle: the listener+timer are torn down on resolve,
  // timeout, OR cancel(), so a setup failure (e.g. Overlay.setInspectMode
  // rejecting) cannot leave a pending wait that later rejects unhandled and
  // leaks a listener/timer until the timeout fires.
  private waitForEvent<T>(
    event: string,
    sessionId: string,
    timeoutMs: number,
  ): { promise: Promise<T>; cancel: () => void } {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    let listener!: (params: unknown, sid?: string) => void;
    let rejectFn!: (e: unknown) => void;
    const cleanup = (): void => {
      clearTimeout(timer);
      this.cdp.off(event, listener);
    };
    const promise = new Promise<T>((resolve, reject) => {
      rejectFn = reject;
      listener = (params: unknown, sid?: string): void => {
        if (done || sid !== sessionId) return;
        done = true;
        cleanup();
        resolve(params as T);
      };
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new ShuttleError("mark_pick_timeout", "No element picked before timeout."));
      }, timeoutMs);
      this.cdp.on(event, listener);
    });
    const cancel = (): void => {
      if (done) return;
      done = true;
      cleanup();
      rejectFn(new ShuttleError("mark_pick_cancelled", "Mark pick was cancelled."));
    };
    return { promise, cancel };
  }

  private async describeBackendNode(
    sessionId: string,
    backendNodeId: number,
  ): Promise<{ tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean }> {
    const { object } = await this.cdp.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId },
      sessionId,
    );
    try {
      const r = await this.cdp.send<{ result: { value: {
        tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean;
      } } }>(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          returnByValue: true,
          functionDeclaration: `function(){
            const i = this instanceof HTMLInputElement ? this : null;
            const ta = this instanceof HTMLTextAreaElement ? this : null;
            return {
              tag: this.tagName.toLowerCase(),
              type: i ? i.type : undefined,
              name: (i && i.name) || (ta && ta.name) || undefined,
              id: this.id || undefined,
              editable: this instanceof HTMLElement && this.isContentEditable,
              role: this.getAttribute("role") || undefined,
              ariaLabel: this.getAttribute("aria-label") || undefined,
              href: this.tagName.toLowerCase() === "a" ? this.hasAttribute("href") : false,
            };
          }`,
        },
        sessionId,
      );
      return r.result.value;
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
    }
  }

  // Bounded CDP send: clears its timer on response and drops the pending entry
  // on timeout (see CdpClient.sendWithTimeout) so a hung transport fails the
  // route closed WITHOUT leaking a timer or a pending request. `timeoutMs`
  // defaults to the per-call cap but callers with a tighter overall deadline
  // (observeText's success-wait) pass a smaller remaining budget.
  private boundedSend<T>(
    method: string,
    params: unknown,
    sessionId: string | undefined,
    timeoutMs: number = this.cdpCallTimeoutMs,
  ): Promise<T> {
    return this.cdp.sendWithTimeout<T>(method, params, sessionId, timeoutMs);
  }

  // Walk self -> ancestors to the nearest element whose elementKind is field/button/link.
  private async normalizeToActionable(sessionId: string, backendNodeId: number): Promise<number> {
    const { object } = await this.cdp.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId },
      sessionId,
    );
    try {
      const r = await this.cdp.send<{ result: { objectId?: string; subtype?: string } }>(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration: NORMALIZE_TO_ACTIONABLE_FN,
        },
        sessionId,
      );
      // Runtime.callFunctionOn returns the remote object under `result` (a
      // RemoteObject). When the in-page fn returns null (no actionable ancestor)
      // there is no objectId, so this correctly falls through to fail-closed.
      const normalizedObjectId = r.result.objectId;
      if (typeof normalizedObjectId !== "string") {
        throw new ShuttleError("mark_pick_no_actionable", "Picked node has no actionable ancestor.");
      }
      try {
        const desc = await this.cdp.send<{ node: { backendNodeId: number } }>(
          "DOM.describeNode",
          { objectId: normalizedObjectId },
          sessionId,
        );
        return desc.node.backendNodeId;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: normalizedObjectId }, sessionId).catch(() => undefined);
      }
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
    }
  }

  async currentDomainAndTarget(): Promise<{ domain: string; target_id: string }> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ domain: string }>(page.id, "({domain: location.hostname})");
    return { domain: r.domain.toLowerCase(), target_id: page.id };
  }

  async readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; field?: FieldDescriptor; domain?: string; title?: string; urlHost?: string }>(page.id, READ_SCRIPT);
    if (!r.ok || r.field === undefined || r.domain === undefined) throw new Error("focused_field_unavailable");
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, backendNodeId, r.field);
    return {
      domain: r.domain.toLowerCase(),
      target_id: page.id,
      field: r.field,
      field_fingerprint: fp,
      ...(r.title !== undefined ? { page_title: r.title } : {}),
      ...(r.urlHost !== undefined ? { page_url_host: r.urlHost } : {}),
    };
  }

  async captureFocused(): Promise<CaptureResult> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; value?: string; field?: FieldDescriptor; domain?: string; reason?: string; title?: string; urlHost?: string }>(page.id, READ_SCRIPT);
    if (!r.ok || r.value === undefined || r.field === undefined || r.domain === undefined) throw new Error(r.reason ?? "focused_field_unavailable");
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, backendNodeId, r.field);
    return {
      value: r.value,
      domain: r.domain.toLowerCase(),
      target_id: page.id,
      field: r.field,
      field_fingerprint: fp,
      ...(r.title !== undefined ? { page_title: r.title } : {}),
      ...(r.urlHost !== undefined ? { page_url_host: r.urlHost } : {}),
    };
  }

  async captureSelection(): Promise<CaptureResult> {
    return this.captureFocused();
  }

  async injectFocused(value: string): Promise<InjectResult> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; field?: FieldDescriptor; domain?: string; reason?: string }>(page.id, WRITE_SCRIPT(value));
    if (!r.ok || r.field === undefined || r.domain === undefined) throw new Error(r.reason ?? "focused_field_unavailable");
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, backendNodeId, r.field);
    return { domain: r.domain.toLowerCase(), target_id: page.id, field: r.field, field_fingerprint: fp };
  }

  async markFocused(): Promise<HandleDescriptor> {
    const page = await this.pickPage();
    const r = await this.evaluate<{
      ok: boolean;
      reason?: string;
      meta?: { tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean };
      domain?: string;
      title?: string;
      urlHost?: string;
    }>(page.id, HANDLE_READ_SCRIPT);
    if (!r.ok || r.meta === undefined || r.domain === undefined) {
      throw new ShuttleError("mark_focused_unavailable", r.reason ?? "No focused element to mark.");
    }
    const kind = elementKind(r.meta);
    if (kind === "other") {
      throw new ShuttleError("mark_kind_unsupported", "Focused element is not a field/button/link.");
    }
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    if (backendNodeId === null) {
      throw new ShuttleError("mark_focused_unavailable", "Could not resolve the focused element.");
    }
    const domain = r.domain.toLowerCase();
    return {
      target_id: page.id,
      domain,
      page_url_host: r.urlHost ?? domain,
      page_title: r.title ?? "",
      backend_node_id: backendNodeId,
      handle_fingerprint: handleFingerprint(domain, page.id, backendNodeId, r.meta, kind),
      element_kind: kind,
    };
  }

  // Precondition: callers clamp timeoutMs; the /v1/browser/mark route enforces the 1s..120s bound.
  async markPick(timeoutMs: number): Promise<HandleDescriptor> {
    const page = await this.pickPage();
    const sessionId = await this.attach(page.id);
    // Register the wait BEFORE setInspectMode so the pick event cannot be missed.
    const wait = this.waitForEvent<{ backendNodeId: number }>(
      "Overlay.inspectNodeRequested",
      sessionId,
      timeoutMs,
    );
    // Pre-attach a no-op catch so a cancel()-induced rejection (setup failure
    // path, where we never await wait.promise) is never an unhandled rejection.
    void wait.promise.catch(() => undefined);
    try {
      await this.cdp.send("DOM.enable", {}, sessionId);
      await this.cdp.send("Overlay.enable", {}, sessionId);
      await this.cdp.send(
        "Overlay.setInspectMode",
        { mode: "searchForNode", highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.4 } } },
        sessionId,
      );
      const ev = await wait.promise;
      const actionableBackendNodeId = await this.normalizeToActionable(sessionId, ev.backendNodeId);
      const meta = await this.describeBackendNode(sessionId, actionableBackendNodeId);
      const kind = elementKind(meta);
      if (kind === "other") {
        throw new ShuttleError("mark_kind_unsupported", "Picked element is not a field/button/link.");
      }
      const loc = await this.evaluate<{ domain: string; title: string; urlHost: string }>(
        page.id,
        "({domain: location.hostname, title: document.title, urlHost: location.host})",
      );
      const domain = loc.domain.toLowerCase();
      return {
        target_id: page.id,
        domain,
        page_url_host: loc.urlHost,
        page_title: loc.title,
        backend_node_id: actionableBackendNodeId,
        handle_fingerprint: handleFingerprint(domain, page.id, actionableBackendNodeId, meta, kind),
        element_kind: kind,
      };
    } catch (err) {
      wait.cancel();
      throw err;
    } finally {
      await this.cdp.send("Overlay.setInspectMode", { mode: "none" }, sessionId).catch(() => undefined);
      await this.cdp.send("Overlay.disable", {}, sessionId).catch(() => undefined);
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  async revalidateHandle(h: {
    target_id: string;
    domain: string;
    backend_node_id: number;
    handle_fingerprint: string;
    element_kind: ElementKind;
  }): Promise<void> {
    const sessionId = await this.attach(h.target_id).catch(() => {
      throw new ShuttleError("handle_invalid", "Handle target is gone (navigation/detach).");
    });
    try {
      let meta: { tag: string; type?: string; name?: string; id?: string; editable: boolean; role?: string; ariaLabel?: string; href: boolean };
      try {
        meta = await this.describeBackendNode(sessionId, h.backend_node_id);
      } catch {
        throw new ShuttleError("handle_invalid", "Handle element no longer resolvable.");
      }
      const loc = await this.evaluate<{ domain: string }>(h.target_id, "({domain: location.hostname})");
      const domain = loc.domain.toLowerCase();
      const kind = elementKind(meta);
      // Reseed with the STORED backend_node_id by design (spec §3.4): describeBackendNode already
      // proved it still resolves; a node swap at the same id is caught via meta-derived fp drift.
      const fp = handleFingerprint(domain, h.target_id, h.backend_node_id, meta, kind);
      if (domain !== h.domain || kind !== h.element_kind || fp !== h.handle_fingerprint) {
        throw new ShuttleError("handle_invalid", "Handle no longer matches the marked element.");
      }
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  async proveAbsence(secret: string): Promise<AbsenceProofResult> {
    if (secret === "") return { passed: false };
    const overallDeadline = Date.now() + this.cdpCallTimeoutMs * 6;
    let targets: { targetInfos: { targetId: string; type: string }[] };
    try {
      targets = await this.boundedSend<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets", undefined, undefined);
    } catch {
      return { passed: false };
    }
    for (const t of targets.targetInfos.filter((x) => x.type === "page")) {
      if (Date.now() > overallDeadline) return { passed: false };
      let sessionId = "";
      try {
        const a = await this.boundedSend<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true }, undefined);
        sessionId = a.sessionId;
        const r = await this.boundedSend<{ result: { value?: { found?: boolean; inconclusive?: boolean } }; exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          { expression: `(${ABSENCE_SCAN_FN})(${JSON.stringify(secret)})`, returnByValue: true, awaitPromise: false },
          sessionId,
        );
        if (r.exceptionDetails !== undefined) return { passed: false };
        const v = r.result.value;
        if (v === undefined || v.inconclusive === true || v.found !== false) return { passed: false };
      } catch {
        return { passed: false };
      } finally {
        if (sessionId !== "") await this.boundedSend("Target.detachFromTarget", { sessionId }, undefined).catch(() => undefined);
      }
    }
    return { passed: true };
  }

  async observeText(domain: string, text: string, timeoutMs: number): Promise<boolean> {
    const norm = domain.toLowerCase();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // Per-call budget: a single hung CDP call must NOT blow past the caller's
    // success-wait. Each call is capped at the smaller of the per-call cap and
    // the time remaining before `deadline` (spec §4.2 step 11 / §5.3 timeout).
    const callBudget = (): number => Math.max(1, Math.min(this.cdpCallTimeoutMs, deadline - Date.now()));
    for (;;) {
      if (Date.now() >= deadline) return false;
      let targets: { targetInfos: { targetId: string; type: string }[] };
      try {
        targets = await this.boundedSend<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets", undefined, undefined, callBudget());
      } catch {
        return false;
      }
      for (const t of targets.targetInfos.filter((x) => x.type === "page")) {
        if (Date.now() >= deadline) return false;
        let sessionId = "";
        try {
          const a = await this.boundedSend<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true }, undefined, callBudget());
          sessionId = a.sessionId;
          const r = await this.boundedSend<{ result: { value?: { host?: string; has?: boolean } } }>(
            "Runtime.evaluate",
            { expression: `(${OBSERVE_TEXT_FN})(${JSON.stringify(text)})`, returnByValue: true, awaitPromise: false },
            sessionId,
            callBudget(),
          );
          const v = r.result.value;
          if (v !== undefined && typeof v.host === "string") {
            const h = v.host.toLowerCase();
            if ((h === norm || h.endsWith(`.${norm}`)) && v.has === true) return true;
          }
        } catch {
          // ignore this target for this poll round
        } finally {
          if (sessionId !== "") await this.boundedSend("Target.detachFromTarget", { sessionId }, undefined, callBudget()).catch(() => undefined);
        }
      }
      if (Date.now() >= deadline) return false;
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  async injectIntoBackendNode(ref: BackendNodeRef, value: string): Promise<InjectResult> {
    const sessionId = await this.attach(ref.target_id);
    try {
      await this.cdp.send("DOM.focus", { backendNodeId: ref.backend_node_id }, sessionId);
      const ev = await this.cdp.send<{ result: { objectId?: string } }>(
        "Runtime.evaluate",
        { expression: "document.activeElement", returnByValue: false },
        sessionId,
      );
      const objectId = ev.result.objectId;
      if (objectId === undefined) throw new ShuttleError("inject_focus_failed", "Focus did not land on an element.");
      let activeBackend: number;
      try {
        const rn = await this.cdp.send<{ nodeId: number }>("DOM.requestNode", { objectId }, sessionId);
        const d = await this.cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId: rn.nodeId }, sessionId);
        activeBackend = d.node.backendNodeId;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId }, sessionId).catch(() => undefined);
      }
      if (activeBackend !== ref.backend_node_id) {
        throw new ShuttleError("inject_focus_mismatch", "Focused element is not the marked field.");
      }
      // WRITE_SCRIPT targets document.activeElement; the immediately-preceding activeBackend===ref.backend_node_id assertion plus WRITE_SCRIPT's own editability re-check bound the risk. Severed-agent model: only same-page JS could refocus, which is inside the human-approved trust boundary.
      const r = await this.cdp.send<{ result: { value: { ok: boolean; field?: FieldDescriptor; domain?: string; reason?: string } } }>(
        "Runtime.evaluate",
        { expression: WRITE_SCRIPT(value), returnByValue: true, awaitPromise: false },
        sessionId,
      );
      const res = r.result.value;
      if (!res.ok || res.field === undefined || res.domain === undefined) {
        throw new ShuttleError("inject_failed", res.reason ?? "Could not write to the marked field.");
      }
      const fp = fieldFingerprint(res.domain.toLowerCase(), ref.target_id, ref.backend_node_id, res.field);
      return { domain: res.domain.toLowerCase(), target_id: ref.target_id, field: res.field, field_fingerprint: fp };
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  private async isDescendantOf(sessionId: string, ancestorBackendNodeId: number, candidateBackendNodeId: number): Promise<boolean> {
    const a = await this.cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: ancestorBackendNodeId }, sessionId);
    try {
      const d = await this.cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: candidateBackendNodeId }, sessionId);
      try {
        const r = await this.cdp.send<{ result: { value: boolean } }>(
          "Runtime.callFunctionOn",
          {
            objectId: a.object.objectId,
            returnByValue: true,
            arguments: [{ objectId: d.object.objectId }],
            functionDeclaration: "function(other){ return this.contains(other); }",
          },
          sessionId,
        );
        return r.result.value === true;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: d.object.objectId }, sessionId).catch(() => undefined);
      }
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId: a.object.objectId }, sessionId).catch(() => undefined);
    }
  }

  async clickBackendNode(ref: BackendNodeRef): Promise<void> {
    const sessionId = await this.attach(ref.target_id);
    try {
      await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backend_node_id }, sessionId).catch(() => undefined);
      const cq = await this.cdp
        .send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId: ref.backend_node_id }, sessionId)
        .catch(() => ({ quads: [] as number[][] }));
      // Pick the LARGEST-area content fragment, not the first. A control split
      // across fragments (inline wrap, or a box clipped by sticky chrome on a
      // scrollable form — common on the Vercel/Stripe dashboards this targets)
      // can have its FIRST fragment occluded under sticky chrome while a LATER
      // fragment is the real visible box; the max-area quad is the robust click
      // target. Single-fragment controls (the common case) are unaffected.
      let point: { x: number; y: number } | null = null;
      let bestArea = 0;
      for (const q of cq.quads) {
        if (q.length === 8) {
          const xs = [q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0];
          const ys = [q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0];
          const area = polygonArea(xs, ys);
          if (area > 1 && area > bestArea) {
            bestArea = area;
            point = { x: ((xs[0] ?? 0) + (xs[1] ?? 0) + (xs[2] ?? 0) + (xs[3] ?? 0)) / 4, y: ((ys[0] ?? 0) + (ys[1] ?? 0) + (ys[2] ?? 0) + (ys[3] ?? 0)) / 4 };
          }
        }
      }
      if (point === null) {
        const bm = await this.cdp
          .send<{ model?: { content: number[]; width: number; height: number } }>("DOM.getBoxModel", { backendNodeId: ref.backend_node_id }, sessionId)
          .catch(() => ({} as { model?: { content: number[]; width: number; height: number } }));
        const m = bm.model;
        if (m === undefined || m.width <= 0 || m.height <= 0 || m.content.length < 8) {
          throw new ShuttleError("click_no_box", "Submit control has no visible box.");
        }
        const c = m.content;
        point = {
          x: ((c[0] ?? 0) + (c[2] ?? 0) + (c[4] ?? 0) + (c[6] ?? 0)) / 4,
          y: ((c[1] ?? 0) + (c[3] ?? 0) + (c[5] ?? 0) + (c[7] ?? 0)) / 4,
        };
      }
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) {
        throw new ShuttleError("click_offscreen", "Submit control is off-screen.");
      }
      // includeUserAgentShadowDOM:false is safe here: UA shadow only ever flattens to its host (a node-or-ancestor of the real target); it cannot mask a page-author overlay, which is always hit-tested normally. Do NOT flip to true (a UA scrollbar/native-control internal could then hit-test as a "descendant" and weaken this occlusion guard).
      const hit = await this.cdp
        .send<{ backendNodeId?: number }>("DOM.getNodeForLocation", { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: false }, sessionId)
        .catch(() => ({} as { backendNodeId?: number }));
      const hitBackend = hit.backendNodeId;
      if (hitBackend === undefined) throw new ShuttleError("click_hit_test_failed", "Could not hit-test the submit point.");
      if (hitBackend !== ref.backend_node_id) {
        const contained = await this.isDescendantOf(sessionId, ref.backend_node_id, hitBackend).catch(() => false);
        if (!contained) throw new ShuttleError("click_occluded", "Submit point is covered by another element.");
      }
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  // Daemon-only single-element value reader (spec §12). Resolves the marked
  // backend node and reads its value via Runtime.callFunctionOn. The value is
  // returned to the route ONLY (→ upsertSecret); never to the agent.
  // Fail-closed on any error. (The per-candidate safe→revealed gate lives in
  // resolveWithinContainer — ALL THREE modes go through that; this method is
  // the generic §12 reader primitive, kept and tested independently.)
  async readBackendNodeValue(ref: BackendNodeRef): Promise<string> {
    const sessionId = await this.attach(ref.target_id);
    try {
      const { object } = await this.cdp.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: ref.backend_node_id },
        sessionId,
      );
      try {
        const r = await this.cdp.send<{ result: { value: { ok: boolean; value?: string } } }>(
          "Runtime.callFunctionOn",
          {
            objectId: object.objectId,
            returnByValue: true,
            functionDeclaration: `function(){
              try {
                var tag = this.tagName.toLowerCase();
                if (tag === "input" || tag === "textarea") return { ok:true, value: typeof this.value === "string" ? this.value : "" };
                if (this.isContentEditable) return { ok:true, value: typeof this.innerText === "string" ? this.innerText : "" };
                return { ok:true, value: typeof this.textContent === "string" ? this.textContent : "" };
              } catch (e) { return { ok:false }; }
            }`,
          },
          sessionId,
        );
        const v = r.result.value;
        if (v === undefined || v.ok !== true || typeof v.value !== "string") {
          throw new ShuttleError("reveal_read_failed", "Could not read the marked field value.");
        }
        return v.value;
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ShuttleError) throw err;
      throw new ShuttleError("reveal_read_failed", "Field read failed.");
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  // Pre-blind, daemon-only. Resolves the approved field/container backend node
  // and runs BASELINE_SCAN_FN bound to it. Returns hashed/classified entries
  // ONLY (no raw text). Readable siblings are RECORDED, not rejected (§6.1).
  async baselineCandidates(ref: BackendNodeRef): Promise<Baseline> {
    const sessionId = await this.attach(ref.target_id);
    try {
      const { object } = await this.cdp.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: ref.backend_node_id },
        sessionId,
      );
      try {
        const r = await this.cdp.send<{ result: { value: { ok: boolean; entries: { key: string; safety: "safe" | "readable"; fp: string }[]; readableFps: string[]; observable: string } } }>(
          "Runtime.callFunctionOn",
          { objectId: object.objectId, returnByValue: true, functionDeclaration: BASELINE_SCAN_FN },
          sessionId,
        );
        const v = r.result.value;
        if (
          v === undefined ||
          v.ok !== true ||
          !Array.isArray(v.entries) ||
          !v.entries.every(
            (e) =>
              typeof e.key === "string" &&
              (e.safety === "safe" || e.safety === "readable") &&
              typeof e.fp === "string",
          ) ||
          !Array.isArray(v.readableFps) ||
          !v.readableFps.every((x) => typeof x === "string") ||
          typeof v.observable !== "string"
        ) {
          throw new ShuttleError("reveal_baseline_failed", "Could not baseline the approved subtree.");
        }
        return { entries: v.entries, readableFps: v.readableFps, observable: v.observable };
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ShuttleError) throw err;
      throw new ShuttleError("reveal_baseline_failed", "Baseline failed.");
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }

  // Post-reveal, daemon-only. Applies the SAME §6.1 per-candidate
  // safe→revealed gate to ALL THREE modes (`field`/`container`/
  // `focused-after-reveal`). Resolves the approved subtree root backend node
  // (the container, or — mode `field` — the field's OWN backend node so the
  // field is its own sole candidate and a field already readable-unchanged
  // pre-reveal fails closed too), runs RESOLVE_SCAN_FN bound to it (with
  // document.activeElement for focused-after-reveal). RESOLVE_SCAN_FN returns
  // the CHOSEN ELEMENT itself or null — so this mirrors the merged
  // normalizeToActionable RemoteObject pattern EXACTLY: callFunctionOn WITHOUT
  // returnByValue → a RemoteObject; null/subtype:"null"/no-objectId → fail
  // closed. Then DOM.describeNode {objectId} → backendNodeId → DOM-containment
  // proof reusing the EXISTING isDescendantOf (the approved container's backend
  // node must contain — or equal — the chosen node) → read the value EXACTLY
  // ONCE via callFunctionOn on that SAME objectId with returnByValue:true.
  // Every resolved objectId is released in finally (mirrors describeBackendNode/
  // normalizeToActionable). Fail-closed (single ShuttleError; the response is
  // enum-only captured:"unknown" so granular reasons are not surfaced) on no
  // single safe→revealed candidate, containment failure, or any CDP error.
  async resolveWithinContainer(
    ref: BackendNodeRef,
    mode: "field" | "container" | "focused-after-reveal",
    baseline: Baseline,
  ): Promise<{ value: string }> {
    const sessionId = await this.attach(ref.target_id);
    try {
      const { object } = await this.cdp.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: ref.backend_node_id },
        sessionId,
      );
      try {
        // focused-after-reveal: resolve document.activeElement as a callable arg.
        let focusedArg: { objectId: string } | { value: null } = { value: null };
        if (mode === "focused-after-reveal") {
          const ae = await this.cdp.send<{ result: { objectId?: string } }>(
            "Runtime.evaluate",
            { expression: "document.activeElement", returnByValue: false },
            sessionId,
          );
          focusedArg = ae.result.objectId !== undefined ? { objectId: ae.result.objectId } : { value: null };
        }
        try {
          // ONE scan call. RESOLVE_SCAN_FN returns the chosen element itself or
          // null — invoked WITHOUT returnByValue so we get a RemoteObject
          // (mirrors normalizeToActionable). A null/subtype:"null"/no-objectId
          // RemoteObject is every fail-closed selection outcome (zero / >1
          // transition-eligible / already-readable-unchanged / no transition /
          // predicate-fails / focused-non-candidate / empty value).
          const r = await this.cdp.send<{ result: { objectId?: string; subtype?: string } }>(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              arguments: [{ value: baseline }, focusedArg],
              functionDeclaration: RESOLVE_SCAN_FN,
            },
            sessionId,
          );
          const chosenObjectId = r.result.objectId;
          if (typeof chosenObjectId !== "string" || r.result.subtype === "null") {
            throw new ShuttleError(
              "reveal_no_transition",
              "No single safe→revealed candidate after reveal.",
            );
          }
          try {
            const d = await this.cdp.send<{ node: { backendNodeId: number } }>(
              "DOM.describeNode",
              { objectId: chosenObjectId },
              sessionId,
            );
            const chosenBackend = d.node.backendNodeId;
            // DOM-containment proof reusing the EXISTING isDescendantOf: the
            // approved subtree root must CONTAIN or EQUAL the chosen node.
            const contained =
              chosenBackend === ref.backend_node_id ||
              (await this.isDescendantOf(sessionId, ref.backend_node_id, chosenBackend).catch(() => false));
            if (!contained) {
              throw new ShuttleError(
                "reveal_not_contained",
                "Chosen element is not inside the approved container.",
              );
            }
            // Read the value EXACTLY ONCE, daemon-internal, off the SAME
            // objectId (returnByValue:true). The value reaches only the route →
            // vault.upsertSecret; it is NEVER returned to the agent layer or audit.
            const rv = await this.cdp.send<{ result: { value: { ok: boolean; value?: string } } }>(
              "Runtime.callFunctionOn",
              {
                objectId: chosenObjectId,
                returnByValue: true,
                functionDeclaration: `function(){
                  try {
                    var t = this;
                    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return { ok:true, value: typeof t.value === "string" ? t.value : "" };
                    if (t instanceof HTMLElement && t.isContentEditable) return { ok:true, value: typeof t.innerText === "string" ? t.innerText : "" };
                    return { ok:true, value: typeof t.textContent === "string" ? t.textContent : "" };
                  } catch (e) { return { ok:false }; }
                }`,
              },
              sessionId,
            );
            const v = rv.result.value;
            if (v === undefined || v.ok !== true || typeof v.value !== "string" || v.value === "") {
              throw new ShuttleError("reveal_no_transition", "Resolved candidate had no value.");
            }
            return { value: v.value };
          } finally {
            await this.cdp.send("Runtime.releaseObject", { objectId: chosenObjectId }, sessionId).catch(() => undefined);
          }
        } finally {
          if ("objectId" in focusedArg) {
            await this.cdp.send("Runtime.releaseObject", { objectId: focusedArg.objectId }, sessionId).catch(() => undefined);
          }
        }
      } finally {
        await this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, sessionId).catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof ShuttleError) throw err;
      throw new ShuttleError("reveal_resolve_failed", "Resolution failed.");
    } finally {
      await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
  }
}
