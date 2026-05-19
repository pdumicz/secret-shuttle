import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CdpClient, type CdpTransport } from "./cdp-client.js";
import { CdpBrowserOps } from "./internal-ops.js";
import { ShuttleError } from "../../shared/errors.js";

interface Sent { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string }

class ClickTransport extends EventEmitter implements CdpTransport {
  quads: number[][] = [[10, 10, 30, 10, 30, 30, 10, 30]]; // 20x20 square, center (20,20)
  hitBackendNodeId = 55;          // what DOM.getNodeForLocation returns (default, point-independent)
  containsResult = false;         // ancestor.contains(hitNode) result
  mouseEvents: string[] = [];
  mousePoints: { x: number; y: number }[] = []; // (x,y) of every Input.dispatchMouseEvent
  // Optional point-keyed hit-test: when set, DOM.getNodeForLocation returns
  // `handleId` ONLY for the {x,y} the daemon queries (rounded), else `otherId`.
  // Used to prove which quad's centroid the daemon hit-tested.
  pointHit: { x: number; y: number; handleId: number; otherId: number } | null = null;

  send(msg: Sent): void {
    const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
    switch (msg.method) {
      case "Target.attachToTarget": reply({ sessionId: "S-1" }); return;
      case "Target.detachFromTarget":
      case "DOM.scrollIntoViewIfNeeded":
      case "Runtime.releaseObject": reply({}); return;
      case "DOM.getContentQuads": reply({ quads: this.quads }); return;
      case "DOM.getBoxModel":
        reply({ model: { content: [10, 10, 30, 10, 30, 30, 10, 30], width: 20, height: 20 } });
        return;
      case "DOM.getNodeForLocation": {
        if (this.pointHit !== null) {
          const qx = Number(msg.params?.["x"]);
          const qy = Number(msg.params?.["y"]);
          const isTarget = qx === this.pointHit.x && qy === this.pointHit.y;
          reply({ backendNodeId: isTarget ? this.pointHit.handleId : this.pointHit.otherId });
          return;
        }
        reply({ backendNodeId: this.hitBackendNodeId });
        return;
      }
      case "DOM.resolveNode": reply({ object: { objectId: `obj-${Math.random()}` } }); return;
      case "Runtime.callFunctionOn": reply({ result: { value: this.containsResult } }); return;
      case "Input.dispatchMouseEvent":
        this.mouseEvents.push(String(msg.params?.["type"]));
        this.mousePoints.push({ x: Number(msg.params?.["x"]), y: Number(msg.params?.["y"]) });
        reply({});
        return;
      default: reply({}); return;
    }
  }
}

test("clickBackendNode dispatches trusted move→press→release when the point hits the handle node", async () => {
  const t = new ClickTransport();
  t.hitBackendNodeId = 55;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 });
  assert.deepEqual(t.mouseEvents, ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("clickBackendNode passes when the hit node is a DESCENDANT of the handle (icon/text button inner span)", async () => {
  const t = new ClickTransport();
  t.hitBackendNodeId = 999;     // inner span
  t.containsResult = true;       // handle.contains(span) === true
  const ops = new CdpBrowserOps(new CdpClient(t));
  await ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 });
  assert.deepEqual(t.mouseEvents, ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("clickBackendNode fails closed when the point is occluded (hit node not contained)", async () => {
  const t = new ClickTransport();
  t.hitBackendNodeId = 999;
  t.containsResult = false;      // an overlay covers the button
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 }),
    (e: unknown) => e instanceof ShuttleError && e.code === "click_occluded",
  );
  assert.deepEqual(t.mouseEvents, []);
});

test("clickBackendNode picks the LARGEST-area content quad (sticky-header robustness), not the first", async () => {
  const t = new ClickTransport();
  // Fragment order: small clipped fragment FIRST (area 16, centroid (2,2)),
  // then the large real visible box (area 20000, centroid (200,150)).
  t.quads = [
    [0, 0, 4, 0, 4, 4, 0, 4],                       // small: under sticky chrome
    [100, 100, 300, 100, 300, 200, 100, 200],       // large: the real box
  ];
  // Hit-test resolves to the handle (55 == ref) ONLY at the LARGE box centroid.
  // Anywhere else (e.g. the small fragment's (2,2)) returns a non-contained id;
  // containsResult=false so isDescendantOf is false → would throw click_occluded.
  t.pointHit = { x: 200, y: 150, handleId: 55, otherId: 999 };
  t.containsResult = false;
  const ops = new CdpBrowserOps(new CdpClient(t));
  await ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 });
  // Proves max-area selection: the OLD first-quad code would have hit-tested
  // (2,2), gotten 999 (not contained), and thrown click_occluded instead.
  assert.deepEqual(t.mouseEvents, ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.deepEqual(t.mousePoints, [
    { x: 200, y: 150 },
    { x: 200, y: 150 },
    { x: 200, y: 150 },
  ]);
});

test("clickBackendNode fails closed on a zero-area / missing box", async () => {
  const t = new ClickTransport();
  t.quads = []; // no content quads
  // Override getBoxModel to a zero box for this case:
  const origSend = t.send.bind(t);
  t.send = (msg: Sent) => {
    if (msg.method === "DOM.getBoxModel") {
      queueMicrotask(() => t.emit("message", { id: msg.id, result: { model: { content: [0, 0, 0, 0, 0, 0, 0, 0], width: 0, height: 0 } } }));
      return;
    }
    origSend(msg);
  };
  const ops = new CdpBrowserOps(new CdpClient(t));
  await assert.rejects(
    () => ops.clickBackendNode({ target_id: "T-1", backend_node_id: 55 }),
    (e: unknown) => e instanceof ShuttleError && e.code === "click_no_box",
  );
});

test("injectIntoBackendNode focuses the node, asserts activeElement, then writes via the existing path", async () => {
  class InjectTransport extends EventEmitter implements CdpTransport {
    activeBackend = 77;
    send(msg: Sent): void {
      const reply = (result: unknown): void => queueMicrotask(() => this.emit("message", { id: msg.id, result }));
      switch (msg.method) {
        case "Target.attachToTarget": reply({ sessionId: "S-1" }); return;
        case "Target.detachFromTarget":
        case "DOM.focus":
        case "Runtime.releaseObject": reply({}); return;
        case "Runtime.evaluate": {
          const expr = String(msg.params?.["expression"] ?? "");
          if (expr.includes("document.activeElement") && msg.params?.["returnByValue"] === false) {
            reply({ result: { objectId: "ae-1" } });
          } else {
            reply({ result: { value: { ok: true, field: { tag: "input", editable: true }, domain: "vercel.com" } } });
          }
          return;
        }
        case "DOM.requestNode": reply({ nodeId: 1 }); return;
        case "DOM.describeNode": reply({ node: { backendNodeId: this.activeBackend } }); return;
        default: reply({}); return;
      }
    }
  }
  const t = new InjectTransport();
  t.activeBackend = 77;
  const ops = new CdpBrowserOps(new CdpClient(t));
  const r = await ops.injectIntoBackendNode({ target_id: "T-1", backend_node_id: 77 }, "whsec_value");
  assert.equal(r.domain, "vercel.com");
  assert.equal(r.target_id, "T-1");

  const t2 = new InjectTransport();
  t2.activeBackend = 999; // focus landed elsewhere
  const ops2 = new CdpBrowserOps(new CdpClient(t2));
  await assert.rejects(
    () => ops2.injectIntoBackendNode({ target_id: "T-1", backend_node_id: 77 }, "whsec_value"),
    (e: unknown) => e instanceof ShuttleError && e.code === "inject_focus_mismatch",
  );
});
