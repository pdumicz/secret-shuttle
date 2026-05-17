// src/daemon/chrome/internal-ops.ts
import { createHash } from "node:crypto";
import type { CdpClient } from "./cdp-client.js";
import { ShuttleError } from "../../shared/errors.js";

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
  if (sel !== "") return { ok:true, value: sel, source:"selection", field: meta(a), domain: location.hostname };
  if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) return { ok:true, value:a.value, source:"focused-field", field: meta(a), domain: location.hostname };
  if (a instanceof HTMLElement && a.isContentEditable) return { ok:true, value: a.innerText, source:"focused-field", field: meta(a), domain: location.hostname };
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

function fieldFingerprint(domain: string, target: string, backendNodeId: number | null, field: FieldDescriptor): string {
  const seed = JSON.stringify({ domain, target, backendNodeId, ...field });
  return `sha256:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export class CdpBrowserOps implements BrowserOps {
  available = true;
  constructor(private readonly cdp: CdpClient) {}

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

  async currentDomainAndTarget(): Promise<{ domain: string; target_id: string }> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ domain: string }>(page.id, "({domain: location.hostname})");
    return { domain: r.domain.toLowerCase(), target_id: page.id };
  }

  async readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; field?: FieldDescriptor; domain?: string }>(page.id, READ_SCRIPT);
    if (!r.ok || r.field === undefined || r.domain === undefined) throw new Error("focused_field_unavailable");
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, backendNodeId, r.field);
    return { domain: r.domain.toLowerCase(), target_id: page.id, field: r.field, field_fingerprint: fp };
  }

  async captureFocused(): Promise<CaptureResult> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; value?: string; field?: FieldDescriptor; domain?: string; reason?: string }>(page.id, READ_SCRIPT);
    if (!r.ok || r.value === undefined || r.field === undefined || r.domain === undefined) throw new Error(r.reason ?? "focused_field_unavailable");
    const backendNodeId = await this.getFocusedBackendNodeId(page.id);
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, backendNodeId, r.field);
    return { value: r.value, domain: r.domain.toLowerCase(), target_id: page.id, field: r.field, field_fingerprint: fp };
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
}
