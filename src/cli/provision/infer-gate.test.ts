import { test } from "node:test";
import assert from "node:assert/strict";
import { isInferYmlExecutable, type InferredPlanEntry } from "./infer-gate.js";

const ok = (overrides: Partial<InferredPlanEntry> = {}): InferredPlanEntry => ({
  secret: "STRIPE_KEY",
  ref: "ss://stripe/prod/STRIPE_KEY",
  source: { kind: "random_32_bytes" },
  destinations: ["vercel:production"],
  ...overrides,
});

test("fully executable plan → ok: true, no issues", () => {
  const r = isInferYmlExecutable([ok()]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test("source.kind=unknown → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "unknown" } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.secret === "STRIPE_KEY" && i.issue.includes("unknown")));
});

test("capture source with missing url → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "capture" } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("capture") && i.issue.includes("url")));
});

test("capture source with non-https url → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "capture", url: "http://insecure.example" } })]);
  assert.equal(r.ok, false);
});

test("existing source with placeholder=true → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "existing", placeholder: true, ref: "ss://x/y/Z" } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("placeholder")));
});

test("existing source with real ref → executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "existing", placeholder: false, ref: "ss://local/prod/REAL" } })]);
  assert.equal(r.ok, true);
});

test("empty destinations → not executable", () => {
  const r = isInferYmlExecutable([ok({ destinations: [] })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.toLowerCase().includes("destination")));
});

test("destination shorthand with OWNER/REPO placeholder → not executable", () => {
  const r = isInferYmlExecutable([ok({ destinations: ["github-actions:OWNER/REPO"] })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("OWNER/REPO")));
});

test("multiple entries, mixed: collects all issues", () => {
  const r = isInferYmlExecutable([
    ok(),
    ok({ secret: "X", source: { kind: "unknown" } }),
    ok({ secret: "Y", destinations: [] }),
  ]);
  assert.equal(r.ok, false);
  // Destructure with explicit guards so the test typechecks under
  // noUncheckedIndexedAccess (length assertions don't narrow index access).
  const [issueA, issueB, ...rest] = r.issues;
  assert.equal(rest.length, 0);
  assert.ok(issueA !== undefined && issueB !== undefined, "expected two issues");
  assert.equal(issueA.secret, "X");
  assert.equal(issueB.secret, "Y");
});

test("capture url with embedded credentials → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "capture", url: "https://user:pass@example.com/" } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("credentials")));
});

test("capture url targeting localhost → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "capture", url: "https://localhost/" } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("localhost")));
});

test("capture url targeting IP literal → not executable", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "capture", url: "https://192.168.1.1/" } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("IP literal")));
});

test("existing source with placeholder=false but no ref → not executable", () => {
  // `ref` is optional in the type, so omitting it is a valid construction
  // for this test. The gate's job is to reject it at runtime.
  const r = isInferYmlExecutable([ok({ source: { kind: "existing", placeholder: false } })]);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.issue.includes("missing required ref")));
});

test("random_64_bytes source → executable (forward-compat union member)", () => {
  const r = isInferYmlExecutable([ok({ source: { kind: "random_64_bytes" } })]);
  assert.equal(r.ok, true);
});
