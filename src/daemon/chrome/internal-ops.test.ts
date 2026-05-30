import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { READ_META_SCRIPT } from "./internal-ops.js";

function refFieldFingerprint(
  domain: string,
  target: string,
  backendNodeId: number | null,
  field: { tag: string; type?: string; name?: string; id?: string; editable: boolean },
): string {
  const seed = JSON.stringify({ domain, target, backendNodeId, ...field });
  return `sha256:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

test("two same-metadata fields with different backendNodeIds produce different fingerprints", () => {
  const f = { tag: "input", type: "text", name: "value", editable: true };
  const a = refFieldFingerprint("page.example.com", "T1", 100, f);
  const b = refFieldFingerprint("page.example.com", "T1", 101, f);
  assert.notEqual(a, b);
});

test("same backendNodeId produces same fingerprint", () => {
  const f = { tag: "input", type: "text", name: "value", editable: true };
  const a = refFieldFingerprint("page.example.com", "T1", 100, f);
  const b = refFieldFingerprint("page.example.com", "T1", 100, f);
  assert.equal(a, b);
});

test("null backendNodeId vs numeric produces different fingerprints", () => {
  const f = { tag: "input", type: "text", name: "value", editable: true };
  const a = refFieldFingerprint("page.example.com", "T1", null, f);
  const b = refFieldFingerprint("page.example.com", "T1", 100, f);
  assert.notEqual(a, b);
});

// Burst 7 §2 (5q). The pre-approval preflight must read NO candidate value
// TEXT, while still mirroring READ_SCRIPT's acceptance set (selection-present
// OR editable active element). It may call getSelection() for a VALUE-FREE
// presence check (isCollapsed / rangeCount — booleans), but must never
// stringify the selection (.toString()) or read .value / .innerText.
// (Spec §2 compare reorder + "Regression test (named)".)
test("READ_META_SCRIPT reads no candidate value TEXT (no selection .toString()/.value/.innerText)", () => {
  // Value-free selection PRESENCE (getSelection().isCollapsed/rangeCount) is
  // ALLOWED — what's forbidden is reading the selected TEXT or field value.
  assert.doesNotMatch(READ_META_SCRIPT, /getSelection\(\)\s*[?.]*\s*\.\s*toString/, "must not stringify the selection");
  assert.doesNotMatch(READ_META_SCRIPT, /\.value\b/, "must not read input .value");
  assert.doesNotMatch(READ_META_SCRIPT, /innerText/, "must not read contentEditable text");
  // It SHOULD still expose the metadata fields the preflight needs.
  assert.match(READ_META_SCRIPT, /domain/);
  assert.match(READ_META_SCRIPT, /field/);
});

test("READ_META_SCRIPT mirrors READ_SCRIPT acceptance: selection presence is accepted without requiring an editable active element", () => {
  // Regression pin for the selection-mode compare path: READ_SCRIPT returns
  // ok:true / source:"selection" when a non-empty selection exists EVEN IF the
  // active element is not editable. READ_META_SCRIPT must keep that branch
  // (value-free) so compare-on-selection against non-editable page text is not
  // rejected at the preflight. Assert the script has a selection-present accept
  // branch (source:"selection") that does NOT gate on isField.
  assert.match(READ_META_SCRIPT, /isCollapsed/, "uses the value-free selection-presence predicate");
  assert.match(READ_META_SCRIPT, /source\s*:\s*["']selection["']/, "accepts the selection-present case");
  // The selection accept must come BEFORE the not_editable rejection (so a
  // selection on a non-editable element is accepted, not rejected).
  const selIdx = READ_META_SCRIPT.search(/source\s*:\s*["']selection["']/);
  const notEditableIdx = READ_META_SCRIPT.search(/not_editable/);
  assert.ok(selIdx > -1 && notEditableIdx > -1 && selIdx < notEditableIdx,
    "selection-present accept must precede the not_editable rejection");
});
