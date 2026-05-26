import { launchChrome } from "../chrome/launch.js";
import { CdpBrowserOps } from "../chrome/internal-ops.js";
import { startCdpProxy } from "../proxy/cdp-proxy.js";
import type { CdpClient } from "../chrome/cdp-client.js";
import type { ProxyServer } from "../proxy/cdp-proxy.js";
import type { BrowserOps } from "../chrome/internal-ops.js";
import type { DaemonBlindModeState } from "../services-blind.js";

export interface BrowserSessionChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
}

export interface BrowserSession {
  owner: { kind: "user" } | { kind: "bootstrap"; batchId: string };
  child: BrowserSessionChild;
  cdp: CdpClient;
  proxy: ProxyServer | null;
  browserSessionId: string;
  browser: BrowserOps;
}

export async function createBrowserSession(opts: {
  profile: string;
  blind: DaemonBlindModeState;
  owner: { kind: "user" } | { kind: "bootstrap"; batchId: string };
}): Promise<BrowserSession> {
  const chrome = await launchChrome({ profile: opts.profile });
  const proxy = await startCdpProxy({
    transport: chrome.transport,
    cdp: chrome.cdp,
    blind: opts.blind,
  });
  return {
    owner: opts.owner,
    child: chrome.child,
    cdp: chrome.cdp,
    proxy,
    browserSessionId: proxy.url,
    browser: new CdpBrowserOps(chrome.cdp),
  };
}
