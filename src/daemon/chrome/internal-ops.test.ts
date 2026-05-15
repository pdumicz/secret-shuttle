import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

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
