import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
import { assertSecretActionAllowed } from "./policy.js";
import type { SecretRecord } from "../vault/types.js";

function rec(actions: SecretRecord["allowed_actions"]): SecretRecord {
  return {
    id: "sec_1", ref: "ss://local/dev/X", name: "X", environment: "development",
    source: "local", created_at: "", updated_at: "", last_used_at: null,
    fingerprint: "hmac-sha256:x", allowed_domains: [], allowed_actions: actions,
    requires_approval: false, classification: "secret", value: "v",
  };
}

test("assertSecretActionAllowed passes when the action is allowed", () => {
  assert.doesNotThrow(() => assertSecretActionAllowed(rec(["inject_into_field"]), "inject_into_field"));
});

test("assertSecretActionAllowed throws action_not_allowed when the action is excluded", () => {
  assert.throws(
    () => assertSecretActionAllowed(rec(["compare_fingerprint"]), "inject_into_field"),
    (e) => e instanceof ShuttleError && e.code === "action_not_allowed",
  );
});
