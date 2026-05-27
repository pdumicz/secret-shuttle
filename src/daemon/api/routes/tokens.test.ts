import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import { deriveHmac, formatBearer } from "../../auth/token-derive.js";
import { rootTokenFingerprint } from "../../auth/root-token-fingerprint.js";
import { getShuttlePaths } from "../../../shared/config.js";

// ── shared harness ──────────────────────────────────────────────────────────
// Mirrors approvals-session.test.ts / bootstrap-owner.test.ts (A10/A11):
// 32-byte random root token so agent bearers can be derived via
// deriveHmac + formatBearer. Inlined here per the A12 plan — do NOT extract
// to a shared module yet.

async function withDaemon<T>(
  fn: (ctx: { port: number; token: string; services: DaemonServices }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-tokens-mint-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";
  // 32-byte base64url root token. deriveHmac rejects anything else with
  // root_token_malformed (see src/daemon/auth/token-derive.ts).
  const rootToken = randomBytes(32).toString("base64url");
  const server = new DaemonServer({ token: rootToken });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: rootToken, services });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    if (prevNoOpen === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prevNoOpen;
    await rm(home, { recursive: true, force: true });
  }
}

async function call(
  ctx: { port: number; token: string },
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await callWithBearer(ctx, ctx.token, method, p, body);
}

async function callWithBearer(
  ctx: { port: number },
  bearer: string,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function agentBearer(rootToken: string, agentId: string): string {
  return formatBearer(agentId, deriveHmac(rootToken, agentId));
}

// ── tests ───────────────────────────────────────────────────────────────────

test("POST /v1/tokens/mint: root can mint any agent_id", async () => {
  // Root is unrestricted — minting an entirely unrelated id like
  // "claude-anything" must succeed and produce a token of the form
  // "claude-anything.<hmac>" derived from the daemon's root token.
  await withDaemon(async (ctx) => {
    const r = await call(ctx, "POST", "/v1/tokens/mint", { agent_id: "claude-anything" });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; token: string; agent_id: string };
    assert.equal(body.ok, true);
    assert.equal(body.agent_id, "claude-anything");
    // Token shape: "<agent_id>.<base64url-hmac>", and the hmac is exactly
    // what we'd derive from the same root token + agent_id locally.
    const expectedHmac = deriveHmac(ctx.token, "claude-anything");
    assert.equal(body.token, formatBearer("claude-anything", expectedHmac));
  });
});

test("POST /v1/tokens/mint: non-root can mint a child within its namespace", async () => {
  // Caller "claude-7f2a" mints child "claude-7f2a.helper-3a1b" — the child
  // id starts with the caller's id + ".", which is allowed.
  await withDaemon(async (ctx) => {
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "claude-7f2a.helper-3a1b",
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
    const body = r.body as { ok: boolean; token: string; agent_id: string };
    assert.equal(body.ok, true);
    assert.equal(body.agent_id, "claude-7f2a.helper-3a1b");
    assert.equal(
      body.token,
      formatBearer("claude-7f2a.helper-3a1b", deriveHmac(ctx.token, "claude-7f2a.helper-3a1b")),
    );
  });
});

test("POST /v1/tokens/mint: non-root CANNOT mint outside namespace", async () => {
  // Caller "claude-7f2a" tries to mint an entirely unrelated id
  // "cursor-deadbeef" — rejected with agent_id_namespace_violation.
  await withDaemon(async (ctx) => {
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "cursor-deadbeef",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "agent_id_namespace_violation",
      `expected agent_id_namespace_violation, got: ${error.code} body=${JSON.stringify(r.body)}`,
    );
  });
});

test("POST /v1/tokens/mint: non-root CANNOT mint own identity again", async () => {
  // Caller "claude-7f2a" tries to mint "claude-7f2a" (itself, no child
  // suffix). The namespace check requires a strict sub-id, so this is
  // rejected with agent_id_namespace_violation — preventing re-issuance
  // of one's own token via a stateless mint loop.
  await withDaemon(async (ctx) => {
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "claude-7f2a",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "agent_id_namespace_violation",
      `expected agent_id_namespace_violation for self-mint, got: ${error.code} body=${JSON.stringify(r.body)}`,
    );
  });
});

test("POST /v1/tokens/mint: non-root CANNOT mint with trailing-dot-only suffix", async () => {
  // Regression for M5: the regex /^[a-z][a-z0-9._-]{0,63}$/ accepts
  // "claude-7f2a." (trailing dot, no suffix). assertAgentIdValid passes,
  // and `requested.startsWith(requiredPrefix)` is also true — only the
  // `length === requiredPrefix.length` guard rejects this. Without that
  // guard a caller could mint a zero-suffix child token.
  await withDaemon(async (ctx) => {
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "claude-7f2a.",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
    const error = (r.body as { error: { code: string } }).error;
    assert.equal(
      error.code,
      "agent_id_namespace_violation",
      `expected agent_id_namespace_violation for trailing-dot mint, got: ${error.code} body=${JSON.stringify(r.body)}`,
    );
  });
});

test("POST /v1/tokens/mint: audit row carries root_token_fp (8-char hex of SHA-256(root))", async () => {
  // T4 regression: every tokens_mint audit row must include the active root
  // fingerprint so post-rotate forensics can bucket mint events by which
  // generation of the root they were bound to. Verifies both that the field
  // is present + correctly shaped AND that the value matches the deterministic
  // fingerprint of the daemon's actual root token.
  await withDaemon(async (ctx) => {
    // Capture the audit path BEFORE awaiting anything that might let a
    // parallel test shift SECRET_SHUTTLE_HOME (mirrors approvals-session.test).
    const auditPath = getShuttlePaths().auditLogPath;

    const r = await call(ctx, "POST", "/v1/tokens/mint", { agent_id: "claude-fp-success" });
    assert.equal(r.status, 200, `mint should succeed: ${JSON.stringify(r.body)}`);

    const lines = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const mintRow = lines.find(
      (row) => row.action === "tokens_mint" && row.child_agent_id === "claude-fp-success",
    );
    assert.ok(mintRow !== undefined, "tokens_mint audit row must be present");
    assert.equal(mintRow.ok, true);
    assert.match(
      mintRow.root_token_fp as string,
      /^[0-9a-f]{8}$/,
      `root_token_fp must be 8 hex chars, got: ${mintRow.root_token_fp}`,
    );
    // Cross-check the fingerprint value: it must be the deterministic SHA-256
    // prefix of the daemon's actual root token (not some random string).
    assert.equal(
      mintRow.root_token_fp,
      rootTokenFingerprint(ctx.token),
      "audit fingerprint must match rootTokenFingerprint(actual root token)",
    );
  });
});

test("POST /v1/tokens/mint: failure audit row also carries root_token_fp", async () => {
  // The failure-path audit emission (catch block) was added in an earlier
  // review round (I1) to record rejected mint attempts. T4 must stamp the
  // fingerprint on that row too — without it, an attacker who triggers
  // namespace violations could pollute the audit log with rows whose
  // generation cannot be identified.
  await withDaemon(async (ctx) => {
    const auditPath = getShuttlePaths().auditLogPath;
    const callerBearer = agentBearer(ctx.token, "claude-7f2a");
    // Trigger an agent_id_namespace_violation: caller tries to mint outside
    // its namespace. The route catches, writes a failure audit row, then
    // rethrows.
    const r = await callWithBearer(ctx, callerBearer, "POST", "/v1/tokens/mint", {
      agent_id: "cursor-deadbeef",
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);

    const lines = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const failRow = lines.find(
      (row) =>
        row.action === "tokens_mint" &&
        row.ok === false &&
        row.child_agent_id === "cursor-deadbeef",
    );
    assert.ok(failRow !== undefined, "failure tokens_mint audit row must be present");
    assert.equal(failRow.error_code, "agent_id_namespace_violation");
    assert.match(
      failRow.root_token_fp as string,
      /^[0-9a-f]{8}$/,
      `failure row root_token_fp must be 8 hex chars, got: ${failRow.root_token_fp}`,
    );
    assert.equal(failRow.root_token_fp, rootTokenFingerprint(ctx.token));
  });
});

test("POST /v1/tokens/mint: returned token validates against current root_token", async () => {
  // End-to-end proof of stateless HMAC validity: take the returned token,
  // use it as the bearer for /v1/whoami, and confirm the server resolves
  // it back to the same agent_id (and is_root === false because it was
  // minted as a derived agent token, not the root).
  await withDaemon(async (ctx) => {
    const mintRes = await call(ctx, "POST", "/v1/tokens/mint", {
      agent_id: "claude-validate-self",
    });
    assert.equal(mintRes.status, 200, `mint failed: ${JSON.stringify(mintRes.body)}`);
    const mint = mintRes.body as { token: string; agent_id: string };

    const whoRes = await callWithBearer(ctx, mint.token, "GET", "/v1/whoami");
    assert.equal(whoRes.status, 200, `whoami failed: ${JSON.stringify(whoRes.body)}`);
    const who = whoRes.body as { ok: boolean; agent_id: string; is_root: boolean };
    assert.equal(who.ok, true);
    assert.equal(
      who.agent_id,
      "claude-validate-self",
      `whoami must echo the minted agent_id, got: ${who.agent_id}`,
    );
    assert.equal(who.is_root, false, "minted agent tokens must NOT be is_root");
  });
});
