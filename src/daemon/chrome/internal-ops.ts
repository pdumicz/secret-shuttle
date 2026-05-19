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
}

const READ_SCRIPT = `
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
          for (const a of el.attributes) {
            const nm = a.name;
            if (nm === "value" || nm === "placeholder" || nm === "title" || nm === "aria-label" || nm.indexOf("data-") === 0) {
              if (hit(a.value)) return { hit:true };
            }
          }
        }
        if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && hit(el.value)) return { hit:true };
        try { if (el.isContentEditable && hit(el.innerText)) return { hit:true }; } catch (e) {}
        if ((el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") && hit(el.textContent)) return { hit:true };
        if (el.tagName === "TEMPLATE") { try { if (el.content && hit(el.content.textContent)) return { hit:true }; } catch (e) { return { inconclusive:true }; } }
        if (el.shadowRoot) { for (const c of el.shadowRoot.children) stack.push(c); }
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

function fieldFingerprint(domain: string, target: string, backendNodeId: number | null, field: FieldDescriptor): string {
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
}
