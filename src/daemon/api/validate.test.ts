import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { asObject, reqString, optStringArray } from "./validate.js";

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
