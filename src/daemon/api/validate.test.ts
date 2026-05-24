import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { asObject, reqString, optStringArray, optStringRecord, optApprovalIds } from "./validate.js";

test("asObject rejects non-objects with bad_request", () => {
  assert.throws(() => asObject(null), (e) => e instanceof ShuttleError && e.code === "bad_request");
  assert.throws(() => asObject([]), (e) => e instanceof ShuttleError && e.code === "bad_request");
});

test("reqString names the offending field", () => {
  assert.throws(
    () => reqString({}, "ref"),
    (e) => e instanceof ShuttleError && e.code === "bad_request" && e.message.includes("ref"),
  );
  assert.equal(reqString({ ref: "x" }, "ref"), "x");
});

test("optStringArray validates element types", () => {
  assert.equal(optStringArray({}, "d"), undefined);
  assert.throws(() => optStringArray({ d: [1] }, "d"), (e) => e instanceof ShuttleError);
  assert.deepEqual(optStringArray({ d: ["a"] }, "d"), ["a"]);
});

test("optStringRecord rejects non-object shapes with bad_request", () => {
  assert.throws(
    () => optStringRecord({ p: null }, "p"),
    (e) => e instanceof ShuttleError && e.code === "bad_request",
  );
  assert.throws(
    () => optStringRecord({ p: [] }, "p"),
    (e) => e instanceof ShuttleError && e.code === "bad_request",
  );
  assert.throws(
    () => optStringRecord({ p: "not-an-object" }, "p"),
    (e) => e instanceof ShuttleError && e.code === "bad_request",
  );
  assert.throws(
    () => optStringRecord({ p: 42 }, "p"),
    (e) => e instanceof ShuttleError && e.code === "bad_request",
  );
});

test("optStringRecord rejects non-string values and names the offending key", () => {
  assert.throws(
    () => optStringRecord({ p: { name: 123 } }, "p"),
    (e) =>
      e instanceof ShuttleError &&
      e.code === "bad_request" &&
      e.message.includes("p") &&
      e.message.includes("name"),
  );
  assert.throws(
    () => optStringRecord({ p: { ok: "x", bad: null } }, "p"),
    (e) =>
      e instanceof ShuttleError &&
      e.code === "bad_request" &&
      e.message.includes("bad"),
  );
});

test("optStringRecord returns undefined when missing and the record on happy path", () => {
  assert.equal(optStringRecord({}, "p"), undefined);
  assert.deepEqual(optStringRecord({ p: {} }, "p"), {});
  assert.deepEqual(optStringRecord({ p: { a: "x", b: "y" } }, "p"), { a: "x", b: "y" });
});

test("optApprovalIds: empty body → undefined", () => {
  assert.strictEqual(optApprovalIds({}), undefined);
});

test("optApprovalIds: singular approval_id → [approval_id]", () => {
  assert.deepStrictEqual(optApprovalIds({ approval_id: "a" }), ["a"]);
});

test("optApprovalIds: approval_ids array → array", () => {
  assert.deepStrictEqual(optApprovalIds({ approval_ids: ["a", "b"] }), ["a", "b"]);
});

test("optApprovalIds: both fields supplied → bad_request approval_id_and_approval_ids_supplied", () => {
  assert.throws(
    () => optApprovalIds({ approval_id: "a", approval_ids: ["b"] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request" && e.message.includes("approval_id_and_approval_ids_supplied"),
  );
});

test("optApprovalIds: approval_ids with duplicates → bad_request duplicate_approval_id", () => {
  assert.throws(
    () => optApprovalIds({ approval_ids: ["a", "a"] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request" && e.message.includes("duplicate_approval_id"),
  );
});

test("optApprovalIds: empty array → undefined", () => {
  assert.strictEqual(optApprovalIds({ approval_ids: [] }), undefined);
});

test("optApprovalIds: approval_id wrong type → bad_request", () => {
  assert.throws(
    () => optApprovalIds({ approval_id: 42 }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request",
  );
});

test("optApprovalIds: approval_ids contains non-string → bad_request", () => {
  assert.throws(
    () => optApprovalIds({ approval_ids: ["a", 42] }),
    (e: unknown) => e instanceof ShuttleError && e.code === "bad_request",
  );
});
