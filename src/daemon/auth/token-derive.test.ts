import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";
import { deriveHmac, formatBearer, parseBearer } from "./token-derive.js";

const root = randomBytes(32).toString("base64url"); // 43 chars

test("deriveHmac: deterministic, 43 chars base64url no pad", () => {
  const a = deriveHmac(root, "claude-abc");
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  const b = deriveHmac(root, "claude-abc");
  assert.equal(a, b);
  const c = deriveHmac(root, "claude-def");
  assert.notEqual(a, c);
});

test("deriveHmac: rejects root_token whose decoded length is not 32 bytes", () => {
  const shortRoot = Buffer.alloc(16, 1).toString("base64url");
  assert.throws(
    () => deriveHmac(shortRoot, "claude-abc"),
    (e: unknown) => e instanceof ShuttleError && e.code === "root_token_malformed",
  );
});

test("formatBearer / parseBearer roundtrip on agent token", () => {
  const hmac = deriveHmac(root, "claude-abc");
  const tok = formatBearer("claude-abc", hmac);
  assert.equal(tok, `claude-abc.${hmac}`);
  const parsed = parseBearer(tok);
  assert.equal(parsed.kind, "agent");
  if (parsed.kind === "agent") {
    assert.equal(parsed.agentId, "claude-abc");
    assert.equal(parsed.hmac, hmac);
  }
});

test("parseBearer: bare token (no dot) is interpreted as root candidate", () => {
  const parsed = parseBearer(root);
  assert.equal(parsed.kind, "root");
  if (parsed.kind === "root") assert.equal(parsed.token, root);
});

test("parseBearer: splits on LAST dot — agent_id may contain dots", () => {
  const hmac = deriveHmac(root, "claude-7f2a.helper-3a");
  const tok = `claude-7f2a.helper-3a.${hmac}`;
  const parsed = parseBearer(tok);
  assert.equal(parsed.kind, "agent");
  if (parsed.kind === "agent") {
    assert.equal(parsed.agentId, "claude-7f2a.helper-3a");
    assert.equal(parsed.hmac, hmac);
  }
});

test("parseBearer: 'root.<anything>' is rejected (reserved) with agent_token_invalid", () => {
  assert.throws(
    () => parseBearer("root.deadbeef"),
    (e: unknown) => e instanceof ShuttleError && e.code === "agent_token_invalid",
  );
});

test("parseBearer: malformed agent_id (bad chars) yields agent_token_invalid", () => {
  assert.throws(
    () => parseBearer("BAD!CHARS.someHmac"),
    (e: unknown) => e instanceof ShuttleError && e.code === "agent_token_invalid",
  );
});
