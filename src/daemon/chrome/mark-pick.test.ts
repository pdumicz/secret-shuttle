import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import { CdpBrowserOps } from "./internal-ops.js";
import { ShuttleError } from "../../shared/errors.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

// Scripted CDP transport returning REALISTIC response shapes for the methods
// markPick drives, and emitting Overlay.inspectNodeRequested after setInspectMode.
class ScriptedTransport extends EventEmitter implements CdpTransport {
  setInspectModeError = false;
  pickAfterSetInspect = true;
  normalizeReturnsNull = false;
  readonly sessionId = "S-1";

  send(msg: Sent): void {
    const reply = (result: unknown): void =>
      queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    const fail = (message: string): void =>
      queueMicrotask(() => this.emit("message", { id: msg.id, error: { code: -1, message } }));
    switch (msg.method) {
      case "Target.getTargets":
        reply({ targetInfos: [{ targetId: "T-1", type: "page", url: "https://vercel.com/app", attached: true }] });
        return;
      case "Target.attachToTarget":
        reply({ sessionId: this.sessionId });
        return;
      case "Target.detachFromTarget":
      case "DOM.enable":
      case "Overlay.enable":
      case "Overlay.disable":
      case "Runtime.releaseObject":
        reply({});
        return;
      case "Overlay.setInspectMode":
        if (this.setInspectModeError) { fail("setInspectMode failed"); return; }
        reply({});
        if (this.pickAfterSetInspect) {
          queueMicrotask(() =>
            this.emit("message", {
              method: "Overlay.inspectNodeRequested",
              params: { backendNodeId: 100 },
              sessionId: this.sessionId,
            }),
          );
        }
        return;
      case "DOM.resolveNode":
        reply({ object: { objectId: "obj-resolved" } });
        return;
      case "Runtime.callFunctionOn": {
        const rbv = msg.params !== undefined && msg.params["returnByValue"] === true;
        if (rbv) {
          // describeBackendNode meta (returnByValue:true → value under result.value)
          reply({ result: { value: {
            tag: "button", type: undefined, name: undefined, id: undefined,
            editable: false, role: undefined, ariaLabel: undefined, href: false,
          } } });
        } else if (this.normalizeReturnsNull) {
          // in-page fn returned null → RemoteObject is a null primitive, no objectId
          reply({ result: { type: "object", subtype: "null", value: null } });
        } else {
          // REAL CDP SHAPE: the returned element RemoteObject is under `result`.
          reply({ result: { objectId: "obj-normalized", type: "object", subtype: "node" } });
        }
        return;
      }
      case "DOM.describeNode":
        reply({ node: { backendNodeId: 207 } });
        return;
      case "Runtime.evaluate":
        reply({ result: { value: { domain: "vercel.com", title: "App", urlHost: "vercel.com" } } });
        return;
      default:
        reply({});
        return;
    }
  }
}

test("markPick resolves a real-shaped CDP pick (regression: callFunctionOn objectId is under result)", async () => {
  const t = new ScriptedTransport();
  const ops = new CdpBrowserOps(new CdpClient(t));
  const desc = await ops.markPick(5_000);
  assert.equal(desc.target_id, "T-1");
  assert.equal(desc.domain, "vercel.com");
  assert.equal(desc.page_url_host, "vercel.com");
  assert.equal(desc.page_title, "App");
  assert.equal(desc.element_kind, "button");
  assert.equal(desc.backend_node_id, 207);
  assert.match(desc.handle_fingerprint, /^sha256:/);
});

test("markPick fails closed (mark_pick_no_actionable) when no actionable ancestor", async () => {
  const t = new ScriptedTransport();
  t.normalizeReturnsNull = true;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.markPick(5_000),
    (e: unknown) => e instanceof ShuttleError && e.code === "mark_pick_no_actionable",
  );
});

test("markPick rejects with the setup error and leaks no pending wait when setInspectMode fails", async () => {
  const t = new ScriptedTransport();
  t.setInspectModeError = true;
  t.pickAfterSetInspect = false;
  const ops = new CdpBrowserOps(new CdpClient(t));

  let unhandled: unknown = null;
  const onUnhandled = (e: unknown): void => { unhandled = e; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const started = Date.now();
    // Short timeout: if the internal wait were leaked, its timeout would fire
    // within the wait window below and surface as an unhandled rejection.
    await assert.rejects(() => ops.markPick(80), /setInspectMode failed/);
    assert.ok(Date.now() - started < 1_000, "must reject promptly, not on the timeout");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(unhandled, null, "cancelled wait must not leak an unhandled rejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
