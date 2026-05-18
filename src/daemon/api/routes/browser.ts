import { ShuttleError } from "../../../shared/errors.js";
import { launchChrome } from "../../chrome/launch.js";
import { CdpBrowserOps } from "../../chrome/internal-ops.js";
import { startCdpProxy } from "../../proxy/cdp-proxy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { asObject, reqString } from "../validate.js";

interface StartBody { profile?: string; }

const MARK_PICK_TIMEOUT_DEFAULT_MS = 30_000;
const MARK_PICK_TIMEOUT_CAP_MS = 120_000;

export function registerBrowser(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/browser/start", async (_req, raw) => {
    if (services.browser !== null) {
      throw new ShuttleError("browser_already_started", "Browser already started.");
    }
    const b = (raw ?? {}) as StartBody;
    const session = await launchChrome({ profile: b.profile ?? "prod-config" });
    services.browser = new CdpBrowserOps(session.cdp);
    services.cdp = session.cdp;
    const proxy = await startCdpProxy({
      transport: session.transport,
      cdp: session.cdp,
      blind: services.blind,
    });
    services.cdpProxy = proxy;
    services.browserSessionId = proxy.url;
    // New browser session ⇒ a fresh handle namespace. Handles never persist.
    services.handles.clear();
    return { started: true, proxy_url: proxy.url, raw_cdp_url: null, value_visible_to_agent: false };
  });

  server.addRoute("POST", "/v1/browser/mark", async (_req, raw) => {
    const o = asObject(raw);
    const how = reqString(o, "how");
    const label = reqString(o, "label");
    if (how !== "focused" && how !== "pick") {
      throw new ShuttleError("bad_request", "how: must be 'focused' or 'pick'");
    }
    if (services.browser === null) {
      throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
    }
    if (services.blind.current() !== null) {
      throw new ShuttleError("blind_mode_active", "Cannot mark while blind mode is active.");
    }
    let timeoutMs = MARK_PICK_TIMEOUT_DEFAULT_MS;
    const t = o["timeout_ms"];
    if (typeof t === "number" && Number.isFinite(t)) {
      timeoutMs = Math.min(Math.max(1_000, Math.floor(t)), MARK_PICK_TIMEOUT_CAP_MS);
    }
    const desc = how === "focused"
      ? await services.browser.markFocused()
      : await services.browser.markPick(timeoutMs);
    const handle = services.handles.put({ label, ...desc });
    return {
      marked: true,
      label: handle.label,
      element_kind: handle.element_kind,
      domain: handle.domain,
      expires_at: handle.expires_at,
      value_visible_to_agent: false,
    };
  });

  server.addRoute("POST", "/v1/browser/marks", async () => {
    const marks = services.handles.list().map((h) => ({
      label: h.label,
      element_kind: h.element_kind,
      domain: h.domain,
      page_url_host: h.page_url_host,
      created_at: h.created_at,
      expires_at: h.expires_at,
      valid: true,
    }));
    return { marks, value_visible_to_agent: false };
  });
}
