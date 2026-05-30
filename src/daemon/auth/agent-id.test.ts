import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ShuttleError } from "../../shared/errors.js";
import { assertAgentIdValid, deriveAutoAgentId, resolveProjectScope } from "./agent-id.js";

const AGENT_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

test("assertAgentIdValid accepts valid forms", () => {
  for (const id of ["claude-abc", "cursor.foo", "claude-7f2a.helper-3a", "a", "z0", "x_y", "abc.def.ghi"]) {
    assertAgentIdValid(id);
  }
});

test("assertAgentIdValid rejects 'root' (reserved) with agent_id_invalid", () => {
  assert.throws(
    () => assertAgentIdValid("root"),
    (e: unknown) => e instanceof ShuttleError && e.code === "agent_id_invalid",
  );
});

test("assertAgentIdValid rejects 'daemon' (reserved no-ALS sentinel) with agent_id_invalid", () => {
  // Burst 5 §2b codex-gate finding: getCurrentAgentId() returns "daemon"
  // as the no-ALS sentinel. If "daemon" were a valid agent id, a privileged
  // actor could mint a "daemon"-named token whose auto-matched sessions
  // would collide with the sentinel-based defensive excludes elsewhere
  // (health route filter, require-approvals auto-match guard). Reserving
  // at the producer side closes that conflation.
  assert.throws(
    () => assertAgentIdValid("daemon"),
    (e: unknown) => e instanceof ShuttleError && e.code === "agent_id_invalid",
  );
});

test("assertAgentIdValid rejects empty / bad-charset / leading-dash / uppercase / too-long", () => {
  for (const id of ["", "-abc", "ABC", "a/b", "x@y", "1abc", "a".repeat(65)]) {
    assert.throws(
      () => assertAgentIdValid(id),
      (e: unknown) => e instanceof ShuttleError && e.code === "agent_id_invalid",
      `expected reject: ${JSON.stringify(id)}`,
    );
  }
});

test("deriveAutoAgentId: deterministic per (machine_id, runtime)", () => {
  const a = deriveAutoAgentId("claude", "machine-abc");
  const b = deriveAutoAgentId("claude", "machine-abc");
  assert.equal(a, b);
});

test("deriveAutoAgentId: different runtime → different id", () => {
  const a = deriveAutoAgentId("claude", "machine-abc");
  const c = deriveAutoAgentId("cursor", "machine-abc");
  assert.notEqual(a, c);
});

test("deriveAutoAgentId: format is <runtime>-<16 hex chars>", () => {
  const id = deriveAutoAgentId("claude", "machine-abc");
  assert.match(id, /^claude-[0-9a-f]{16}$/);
});

test("deriveAutoAgentId: never collides with the 'root' reserved id", () => {
  // 16 hex chars makes accidental collision astronomical, but assertion is still valid.
  const id = deriveAutoAgentId("root", "any-machine");
  assert.notEqual(id, "root");
  assert.match(id, /^root-[0-9a-f]{16}$/);
});

// ── Burst 7 §1 (Plan 5s): optional projectScope + resolveProjectScope ────────

test("deriveAutoAgentId(2-arg) is byte-identical to the pre-change derivation (regression pin)", () => {
  // Pin the EXACT pre-change formula so a future refactor can't silently
  // change every existing user's id: `${runtime}-${sha256(machineId\x00runtime)[0:16]}`.
  const runtime = "claude";
  const machineId = "00112233445566778899aabbccddeeff";
  const expected = `${runtime}-${createHash("sha256").update(`${machineId}\x00${runtime}`).digest("hex").slice(0, 16)}`;
  assert.equal(deriveAutoAgentId(runtime, machineId), expected);
});

test("deriveAutoAgentId(3-arg) differs from 2-arg, is stable for a fixed scope, and is AGENT_ID_RE-valid", () => {
  const runtime = "claude";
  const machineId = "00112233445566778899aabbccddeeff";
  const scope = "/Users/me/project-a";
  const twoArg = deriveAutoAgentId(runtime, machineId);
  const threeArg = deriveAutoAgentId(runtime, machineId, scope);
  assert.notEqual(threeArg, twoArg, "per-project id must differ from the machine-wide id");
  assert.equal(deriveAutoAgentId(runtime, machineId, scope), threeArg, "same scope → same id (pure hash)");
  assert.match(threeArg, AGENT_ID_RE, "per-project id must still satisfy AGENT_ID_RE");
});

test("deriveAutoAgentId(3-arg): different scopes → different ids", () => {
  const runtime = "claude";
  const machineId = "00112233445566778899aabbccddeeff";
  const idA = deriveAutoAgentId(runtime, machineId, "/Users/me/project-a");
  const idB = deriveAutoAgentId(runtime, machineId, "/Users/me/project-b");
  assert.notEqual(idA, idB, "distinct project scopes must yield distinct ids");
});

test("resolveProjectScope: returns the git-root in a temp git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-scope-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
    const scope = resolveProjectScope(dir);
    // realpath-normalize both sides: macOS /tmp is a symlink to /private/tmp,
    // and `git rev-parse --show-toplevel` returns the realpath'd root.
    const { realpathSync } = await import("node:fs");
    assert.equal(realpathSync(scope), realpathSync(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectScope: returns cwd in a non-repo temp dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-scope-norepo-"));
  try {
    // No `git init` — a bare temp dir. (Guard: if the temp dir is itself
    // inside an enclosing repo, git would return that root; tmpdir() is not.)
    const scope = resolveProjectScope(dir);
    assert.equal(scope, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveProjectScope: returns cwd when git errors (nonexistent cwd)", () => {
  // execFileSync throws (ENOENT on the cwd / git nonzero) → cwd fallback.
  const bogus = "/nonexistent-path-for-ss-scope-test-xyz";
  assert.equal(resolveProjectScope(bogus), bogus);
});
