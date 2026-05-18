import { randomUUID } from "node:crypto";

export type ElementKind = "field" | "button" | "link" | "other";

export interface BrowserHandle {
  handle_id: string;
  label: string;
  target_id: string;
  domain: string;
  page_url_host: string;
  page_title: string;
  backend_node_id: number;
  handle_fingerprint: string;
  element_kind: ElementKind;
  created_at: number;
  expires_at: number;
}

export type HandleInput = Omit<BrowserHandle, "handle_id" | "created_at" | "expires_at">;

const TTL_MS = 5 * 60 * 1000;

/**
 * In-memory, per-browser-session opaque handle store. Never persisted.
 * Label namespace is per session; re-marking a label is last-write-wins;
 * handles expire 5 minutes after creation (then treated as absent — fail closed).
 */
export class BrowserHandleStore {
  private readonly byLabel = new Map<string, BrowserHandle>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  put(input: HandleInput): BrowserHandle {
    const created = this.now();
    const handle: BrowserHandle = {
      ...input,
      handle_id: randomUUID(),
      created_at: created,
      expires_at: created + TTL_MS,
    };
    this.byLabel.set(input.label, handle);
    return handle;
  }

  get(label: string): BrowserHandle | undefined {
    const h = this.byLabel.get(label);
    if (h === undefined) return undefined;
    if (this.now() > h.expires_at) {
      this.byLabel.delete(label);
      return undefined;
    }
    return h;
  }

  list(): BrowserHandle[] {
    const out: BrowserHandle[] = [];
    for (const [label, h] of this.byLabel) {
      if (this.now() > h.expires_at) {
        this.byLabel.delete(label);
        continue;
      }
      out.push(h);
    }
    return out;
  }

  clear(): void {
    this.byLabel.clear();
  }
}
