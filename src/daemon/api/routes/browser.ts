import { ShuttleError } from "../../../shared/errors.js";
import { launchChrome } from "../../chrome/launch.js";
import { CdpBrowserOps } from "../../chrome/internal-ops.js";
import { startCdpProxy } from "../../proxy/cdp-proxy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";

interface StartBody { profile?: string; }

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
    return {
      started: true,
      proxy_url: proxy.url,
      raw_cdp_url: null,
      value_visible_to_agent: false,
    };
  });
}
