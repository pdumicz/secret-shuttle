import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpBrowserOps } from "./internal-ops.js";
import { isShuttleError } from "../../shared/errors.js";

// Minimal scripted CdpClient.
// matchCount drives the querySelectorAll(...).length probe.
// For matchCount === 1, the subsequent DOM round trips resolve to a single concrete node.
// The fake handles ALL calls in the actual sequence CdpBrowserOps makes:
//   selectorMatchCount path: attachToTarget → Runtime.evaluate(querySelectorAll.length, returnByValue:true) → detachFromTarget
//   resolveSelectorToHandle (count===1) then does its own:
//     attachToTarget → Runtime.evaluate(querySelector, returnByValue:false) → DOM.requestNode →
//     DOM.describeNode → Runtime.releaseObject → documentHost (attachToTarget → Runtime.evaluate(location.host) → detachFromTarget) →
//     detachFromTarget
function fakeCdp(matchCount: number) {
  return {
    send: async (method: string, params?: unknown, _sessionId?: string): Promise<unknown> => {
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Target.detachFromTarget") return {};
      if (method === "Runtime.releaseObject") return {};

      if (method === "Runtime.evaluate") {
        const p = params as { expression?: string; returnByValue?: boolean } | undefined;
        const expr = p?.expression ?? "";

        // documentHost call: evaluates "String(location.host)" with returnByValue:true
        if (expr.includes("location.host")) {
          return { result: { value: "stripe.test" } };
        }

        // querySelectorAll.length probe (returnByValue:true) — from selectorMatchCount
        if (expr.includes("querySelectorAll(") && p?.returnByValue === true) {
          return { result: { value: matchCount } };
        }

        // querySelector (returnByValue:false) — single node resolution
        if (expr.includes("querySelector(") && p?.returnByValue === false) {
          return { result: { objectId: "obj-1" } };
        }

        return { result: { value: null } };
      }

      if (method === "DOM.requestNode") return { nodeId: 7 };

      if (method === "DOM.describeNode") {
        return {
          node: {
            backendNodeId: 42,
            nodeName: "INPUT",
            attributes: ["type", "password", "id", "sk", "value", "sk_live_LEAK"],
          },
        };
      }

      throw new Error(`unexpected method: ${method}`);
    },
  } as any;
}

test("resolveSelectorToHandle throws recipe_selector_ambiguous on 0 matches", async () => {
  const ops = new CdpBrowserOps(fakeCdp(0));
  await assert.rejects(
    () => ops.resolveSelectorToHandle("t1", "#x"),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_selector_ambiguous",
  );
});

test("resolveSelectorToHandle throws recipe_selector_ambiguous on >1 matches", async () => {
  const ops = new CdpBrowserOps(fakeCdp(3));
  await assert.rejects(
    () => ops.resolveSelectorToHandle("t1", "#x"),
    (e: unknown) => isShuttleError(e) && e.code === "recipe_selector_ambiguous",
  );
});

test("resolveSelectorToHandle on exactly 1 match returns identity only (no values)", async () => {
  // §246 minimum bar: the exactly-one path must return identity, NOT the value.
  const ops = new CdpBrowserOps(fakeCdp(1));
  const ref = await ops.resolveSelectorToHandle("t1", "#sk");

  // identity shape: { target_id, backend_node_id, fingerprint }
  assert.equal(ref.target_id, "t1");
  assert.equal(ref.backend_node_id, 42);
  assert.equal(typeof ref.fingerprint, "string");
  assert.ok(ref.fingerprint.length > 0);

  // no value-like data is exposed: the resolved node's `value` attr ("sk_live_LEAK")
  // must NEVER appear anywhere in the returned ref (no `value` key, no leak in fingerprint).
  assert.ok(!("value" in ref));
  assert.ok(!JSON.stringify(ref).includes("sk_live_LEAK"));
});
