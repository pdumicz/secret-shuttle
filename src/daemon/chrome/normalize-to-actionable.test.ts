import assert from "node:assert/strict";
import test from "node:test";
import { NORMALIZE_TO_ACTIONABLE_FN } from "./internal-ops.js";

// The function runs in the page; we execute the real exported string here with
// a minimal DOM shim so the self->ancestor climb (incl. the #text start) is
// regression-tested directly, not stubbed.
class FakeHTMLElement {}
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeHTMLElement;

type El = {
  nodeType: 1;
  tagName: string;
  type?: string;
  parentElement: El | null;
  getAttribute: (n: string) => string | null;
  hasAttribute: (n: string) => boolean;
  isContentEditable?: boolean;
};

function el(tagName: string, parent: El | null, attrs: Record<string, string> = {}): El {
  const e = Object.create(FakeHTMLElement.prototype) as El;
  e.nodeType = 1;
  e.tagName = tagName;
  e.parentElement = parent;
  e.getAttribute = (n: string) => (n in attrs ? attrs[n]! : null);
  e.hasAttribute = (n: string) => n in attrs;
  return e;
}
function textNode(parent: El | null): { nodeType: 3; parentElement: El | null } {
  return { nodeType: 3, parentElement: parent };
}

const fn = eval("(" + NORMALIZE_TO_ACTIONABLE_FN + ")") as (this: unknown) => unknown;
const run = (self: unknown): unknown => fn.call(self);

test("a #text node inside a <button> normalizes to the button (P2 regression)", () => {
  const button = el("BUTTON", null);
  const t = textNode(button);
  assert.equal(run(t), button);
});

test("an inner <span> inside an <a href> normalizes to the link", () => {
  const link = el("A", null, { href: "/x" });
  const span = el("SPAN", link);
  assert.equal(run(span), link);
});

test("an <svg> path inside a <button> normalizes to the button", () => {
  const button = el("BUTTON", null);
  const svg = el("SVG", button);
  const path = el("PATH", svg);
  assert.equal(run(path), button);
});

test("returns null when there is no actionable ancestor (fail closed)", () => {
  const div = el("DIV", null);
  const span = el("SPAN", div);
  assert.equal(run(span), null);
});

test("a #text node with no element parent returns null (fail closed)", () => {
  assert.equal(run(textNode(null)), null);
});
