// src/daemon/chrome/internal-ops.ts
import { createHash } from "node:crypto";
import type { CdpClient } from "./cdp-client.js";

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

function fieldFingerprint(domain: string, target: string, field: FieldDescriptor): string {
  const seed = JSON.stringify({ domain, target, ...field });
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

  async currentDomainAndTarget(): Promise<{ domain: string; target_id: string }> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ domain: string }>(page.id, "({domain: location.hostname})");
    return { domain: r.domain.toLowerCase(), target_id: page.id };
  }

  async readFocusedFingerprintAndDomain(): Promise<Omit<CaptureResult, "value">> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; field?: FieldDescriptor; domain?: string }>(page.id, READ_SCRIPT);
    if (!r.ok || r.field === undefined || r.domain === undefined) throw new Error("focused_field_unavailable");
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, r.field);
    return { domain: r.domain.toLowerCase(), target_id: page.id, field: r.field, field_fingerprint: fp };
  }

  async captureFocused(): Promise<CaptureResult> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; value?: string; field?: FieldDescriptor; domain?: string; reason?: string }>(page.id, READ_SCRIPT);
    if (!r.ok || r.value === undefined || r.field === undefined || r.domain === undefined) throw new Error(r.reason ?? "focused_field_unavailable");
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, r.field);
    return { value: r.value, domain: r.domain.toLowerCase(), target_id: page.id, field: r.field, field_fingerprint: fp };
  }

  async captureSelection(): Promise<CaptureResult> {
    return this.captureFocused();
  }

  async injectFocused(value: string): Promise<InjectResult> {
    const page = await this.pickPage();
    const r = await this.evaluate<{ ok: boolean; field?: FieldDescriptor; domain?: string; reason?: string }>(page.id, WRITE_SCRIPT(value));
    if (!r.ok || r.field === undefined || r.domain === undefined) throw new Error(r.reason ?? "focused_field_unavailable");
    const fp = fieldFingerprint(r.domain.toLowerCase(), page.id, r.field);
    return { domain: r.domain.toLowerCase(), target_id: page.id, field: r.field, field_fingerprint: fp };
  }
}
