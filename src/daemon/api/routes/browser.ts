import { ShuttleError } from "../../../shared/errors.js";
import { createBrowserSession } from "../../bootstrap/browser-session.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { asObject, reqString } from "../validate.js";

interface StartBody { profile?: string; }

const MARK_PICK_TIMEOUT_DEFAULT_MS = 30_000;
const MARK_PICK_TIMEOUT_CAP_MS = 120_000;

export function registerBrowser(server: DaemonServer, services: DaemonServices): void {
  server.addRoute("POST", "/v1/browser/start", async (_req, raw) => {
    if (services.browserSession !== null) {
      throw new ShuttleError("browser_already_started", "Browser already started.");
    }
    const b = (raw ?? {}) as StartBody;
    services.browserSession = await createBrowserSession({
      profile: b.profile ?? "prod-config",
      blind: services.blind,
      owner: { kind: "user" },
    });
    // New browser session ⇒ a fresh handle namespace. Handles never persist.
    services.handles.clear();
    return {
      started: true,
      proxy_url: services.browserSession.proxy?.url ?? null,
      raw_cdp_url: null,
      value_visible_to_agent: false,
    };
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
    const browser = services.browser;
    const marks = await Promise.all(
      services.handles.list().map(async (h) => {
        let valid = false;
        if (browser !== null) {
          try {
            await browser.revalidateHandle({
              target_id: h.target_id,
              domain: h.domain,
              backend_node_id: h.backend_node_id,
              handle_fingerprint: h.handle_fingerprint,
              element_kind: h.element_kind,
            });
            valid = true;
          } catch {
            // navigated / detached / drifted / browser gone — fail closed.
            // Detail is intentionally NOT surfaced to the agent.
            valid = false;
          }
        }
        return {
          label: h.label,
          element_kind: h.element_kind,
          domain: h.domain,
          page_url_host: h.page_url_host,
          created_at: h.created_at,
          expires_at: h.expires_at,
          valid,
        };
      }),
    );
    return { marks, value_visible_to_agent: false };
  });
}
