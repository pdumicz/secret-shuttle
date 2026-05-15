import assert from "node:assert/strict";
import test from "node:test";
import { redactKnownSecrets } from "./redactor.js";

test("redactKnownSecrets redacts exact known secret values", () => {
  const redacted = redactKnownSecrets("value is custom-secret-123", ["custom-secret-123"]);
  assert.equal(redacted, "value is [REDACTED_SECRET]");
});

test("redactKnownSecrets redacts common secret patterns", () => {
  const redacted = redactKnownSecrets("stripe whsec_abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(redacted, "stripe [REDACTED_SECRET_PATTERN]");
});
