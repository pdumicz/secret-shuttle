import { chromium, type Browser, type Page } from "playwright-core";
import { ShuttleError } from "../shared/errors.js";
import type { BrowserAdapter, FocusedFieldRead, FocusedFieldSource, FocusedFieldWrite } from "./adapter.js";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export interface PlaywrightFocusedFieldAdapterOptions {
  cdpUrl?: string;
}

export class PlaywrightFocusedFieldAdapter implements BrowserAdapter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly cdpUrl: string;

  constructor(options: PlaywrightFocusedFieldAdapterOptions = {}) {
    this.cdpUrl = options.cdpUrl ?? process.env.SECRET_SHUTTLE_CDP_URL ?? DEFAULT_CDP_URL;
  }

  async currentDomain(): Promise<string> {
    const page = await this.getPage();
    return hostnameFromUrl(page.url());
  }

  async read(source: FocusedFieldSource): Promise<FocusedFieldRead> {
    const page = await this.getPage();
    const domain = hostnameFromUrl(page.url());
    const result = await page.evaluate((requestedSource) => {
      function fieldMetadata(element: Element) {
        const input = element instanceof HTMLInputElement ? element : null;
        const textarea = element instanceof HTMLTextAreaElement ? element : null;
        const editable = element instanceof HTMLElement && element.isContentEditable;

        return {
          tag: element.tagName.toLowerCase(),
          type: input?.type,
          name: input?.name ?? textarea?.name,
          id: element.id,
          editable,
        };
      }

      const active = document.activeElement;
      const selectedText = window.getSelection()?.toString() ?? "";
      if (requestedSource === "selection" && selectedText !== "") {
        return {
          ok: true as const,
          value: selectedText,
          source: "selection" as const,
          field: active instanceof Element
            ? fieldMetadata(active)
            : { tag: "selection", editable: false },
        };
      }

      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        return {
          ok: true as const,
          value: active.value,
          source: "focused-field" as const,
          field: fieldMetadata(active),
        };
      }

      if (active instanceof HTMLElement && active.isContentEditable) {
        return {
          ok: true as const,
          value: active.innerText,
          source: "focused-field" as const,
          field: fieldMetadata(active),
        };
      }

      return {
        ok: false as const,
        reason: requestedSource === "selection"
          ? "No selected text was available, and the focused element is not a text field."
          : "The focused element is not an input, textarea, or contenteditable element.",
      };
    }, source);

    if (!result.ok) {
      throw new ShuttleError("focused_field_unavailable", result.reason);
    }

    if (result.value === "") {
      throw new ShuttleError("empty_capture", "The selected text or focused field is empty.");
    }

    return {
      value: result.value,
      source: result.source,
      domain,
      field: normalizeFieldMetadata(result.field),
    };
  }

  async write(value: string): Promise<FocusedFieldWrite> {
    const page = await this.getPage();
    const domain = hostnameFromUrl(page.url());
    const result = await page.evaluate((secretValue) => {
      function fieldMetadata(element: Element) {
        const input = element instanceof HTMLInputElement ? element : null;
        const textarea = element instanceof HTMLTextAreaElement ? element : null;
        const editable = element instanceof HTMLElement && element.isContentEditable;

        return {
          tag: element.tagName.toLowerCase(),
          type: input?.type,
          name: input?.name ?? textarea?.name,
          id: element.id,
          editable,
        };
      }

      function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, nextValue: string) {
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor?.set?.call(element, nextValue);
      }

      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.focus();
        setNativeValue(active, secretValue);
        active.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          ok: true as const,
          field: fieldMetadata(active),
        };
      }

      if (active instanceof HTMLElement && active.isContentEditable) {
        active.focus();
        active.textContent = secretValue;
        active.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          ok: true as const,
          field: fieldMetadata(active),
        };
      }

      return {
        ok: false as const,
        reason: "The focused element is not an input, textarea, or contenteditable element.",
      };
    }, value);

    if (!result.ok) {
      throw new ShuttleError("focused_field_unavailable", result.reason);
    }

    return {
      injected: true,
      domain,
      field: normalizeFieldMetadata(result.field),
    };
  }

  private async getPage(): Promise<Page> {
    if (this.page !== null && !this.page.isClosed()) {
      return this.page;
    }

    if (this.browser === null || !this.browser.isConnected()) {
      try {
        this.browser = await chromium.connectOverCDP(this.cdpUrl);
      } catch {
        throw new ShuttleError(
          "browser_connection_failed",
          `Could not connect to Chrome over CDP at ${this.cdpUrl}. Start Chrome with remote debugging or run \`secret-shuttle browser start\`.`,
        );
      }
    }

    const pages = this.browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => !page.isClosed());
    const candidates = pages.filter((page) => page.url() !== "about:blank");
    const page = candidates.at(-1) ?? pages.at(-1);

    if (page === undefined) {
      throw new ShuttleError("browser_page_not_found", "No browser page was available over the CDP connection.");
    }

    this.page = page;
    return page;
  }
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeFieldMetadata(field: {
  tag: string;
  type?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  editable: boolean;
}): FocusedFieldRead["field"] {
  return {
    tag: field.tag,
    editable: field.editable,
    ...(field.type !== undefined && field.type !== "" ? { type: field.type } : {}),
    ...(field.name !== undefined && field.name !== "" ? { name: field.name } : {}),
    ...(field.id !== undefined && field.id !== "" ? { id: field.id } : {}),
  };
}
