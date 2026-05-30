/**
 * Integration tests for `secret-shuttle init`.
 *
 * Strategy: spin up an in-process DaemonServer with the relevant routes
 * registered (health, unlock-session, keychain, no full run/inject/etc.),
 * write the daemon socket file to a temp SS_HOME so daemonRequest() can
 * find it, then call initCommand().parseAsync([]) to exercise the full
 * action path.
 *
 * The passphrase UI is bypassed by driving the /ui/unlock/:id submit endpoint
 * directly from the test — same approach used in unlock-session.test.ts.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../daemon/server.js";
import { DaemonServices } from "../../daemon/services.js";
import { registerHealth } from "../../daemon/api/routes/health.js";
import { registerUnlockSession } from "../../daemon/api/routes/unlock-session.js";
import { registerKeychainRoutes } from "../../daemon/api/routes/keychain.js";
import { registerTokens } from "../../daemon/api/routes/tokens.js";
import { writeSocketFile } from "../../daemon/socket-file.js";
import { readEnvelope } from "../../vault/envelope.js";
import { initCommand, resolvePerProjectOptIn } from "./init.js";
import { loadIdentityPerProject } from "./identity-config.js";
import type { KeychainAdapter } from "../../vault/keychain/types.js";
import { deriveAutoAgentId } from "../../daemon/auth/agent-id.js";
import { ShuttleError } from "../../shared/errors.js";
import { deriveHmac, formatBearer } from "../../daemon/auth/token-derive.js";

// ── Mock keychain ─────────────────────────────────────────────────────────────

class MockKeychain implements KeychainAdapter {
  available = true;
  readonly entries = new Map<string, Buffer>();

  async isAvailable(): Promise<boolean> { return this.available; }
  async set(service: string, account: string, value: Buffer): Promise<void> {
    if (!this.available) throw new Error("keychain unavailable");
    this.entries.set(`${service}:${account}`, Buffer.from(value));
  }
  async get(service: string, account: string): Promise<Buffer | null> {
    if (!this.available) throw new Error("keychain unavailable");
    return this.entries.get(`${service}:${account}`) ?? null;
  }
  async delete(service: string, account: string): Promise<void> {
    if (!this.available) throw new Error("keychain unavailable");
    this.entries.delete(`${service}:${account}`);
  }
}

// ── Shared harness ────────────────────────────────────────────────────────────

interface HarnessCtx {
  port: number;
  services: DaemonServices;
  /** The in-process DaemonServer — exposed so tests can override individual
   * routes via server.addRoute() (Map.set overwrites the prior handler), which
   * is the cleanest injection point for failure-mode tests like T1. */
  server: DaemonServer;
  /** SECRET_SHUTTLE_HOME — temp dir where socket file + machine-id + audit live. */
  home: string;
  /** Sandboxed HOME directory — where ~/.claude/settings.json lands. */
  userHome: string;
  /** The 32-byte base64url root token used by the in-process daemon. */
  rootToken: string;
}

async function withInitDaemon<T>(
  fn: (ctx: HarnessCtx) => Promise<T>,
  opts: { keychain?: KeychainAdapter; seedMachineId?: boolean | string } = {},
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-init-test-"));
  // Sandbox HOME so installAgentToken writes ~/.claude/settings.json into a
  // temp directory, never into the real user home (os.homedir() honors HOME on
  // macOS/Linux). We restore HOME on cleanup like the other env vars.
  const userHome = await mkdtemp(path.join(os.tmpdir(), "ss-init-userhome-"));
  const prevHome = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  const prevUserHome = process.env.HOME;
  const prevNoOpen = process.env.SECRET_SHUTTLE_NO_OPEN_URL;
  // ensureDaemonRunning() checks readSocketFile() first. We pre-write the
  // socket file before the init action runs, so the spawn path is never taken
  // — the function sees an existing socket and returns { daemonSpawned: false }.
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  process.env.HOME = userHome;
  // Defense-in-depth against real-browser launches. hubOpenUrlImpl below mocks
  // the HubBroker path, but any other code path (e.g. a future feature that
  // calls openUrl directly) would still spawn a real browser when this test
  // runs under `npx tsx --test <file>` — the npm-test script sets this env
  // var globally, but a file-targeted run bypasses that.
  process.env.SECRET_SHUTTLE_NO_OPEN_URL = "1";

  // 32-byte base64url root token. /v1/tokens/mint uses HMAC-SHA256 keyed on the
  // root_token bytes; deriveHmac rejects anything else with root_token_malformed
  // (see src/daemon/auth/token-derive.ts). Hard-coded "test-token" worked for the
  // earlier health/unlock-only tests because those routes never derive HMACs.
  const rootToken = randomBytes(32).toString("base64url");
  const server = new DaemonServer({ token: rootToken });
  const services = new DaemonServices({
    hubOpenUrlImpl: () => { /* no-op in tests */ },
  });
  if (opts.keychain !== undefined) {
    services.keychain = opts.keychain;
  }

  let port = 0;
  registerHealth(server, services);
  registerUnlockSession(server, services, () => port);
  registerKeychainRoutes(server, services);
  // Required so init can mint per-runtime agent tokens during the action.
  registerTokens(server, () => server.getRootToken());
  ({ port } = await server.listen(0));

  // Write the socket file so daemonRequest() can find the test server.
  await mkdir(home, { recursive: true });
  await writeSocketFile({ port, token: rootToken, pid: process.pid });

  // Seed machine-id so init's per-runtime mint step finds it via readMachineId.
  // In production this file is written during daemon bootstrap (ensureMachineId).
  // The test harness short-circuits the spawn path, so we have to seed it here.
  // Tests can opt out via seedMachineId: false to exercise the "no machine_id
  // yet → skip mint step" branch.
  if (opts.seedMachineId !== false) {
    const id = typeof opts.seedMachineId === "string"
      ? opts.seedMachineId
      : randomBytes(32).toString("base64url");
    await writeFile(path.join(home, "machine-id"), id, { mode: 0o600 });
  }

  try {
    return await fn({ port, services, server, home, userHome, rootToken });
  } finally {
    await server.close();
    if (prevHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prevHome;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    if (prevUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUserHome;
    if (prevNoOpen === undefined) delete process.env.SECRET_SHUTTLE_NO_OPEN_URL;
    else process.env.SECRET_SHUTTLE_NO_OPEN_URL = prevNoOpen;
    await rm(home, { recursive: true, force: true });
    await rm(userHome, { recursive: true, force: true });
  }
}

/**
 * Bootstrap the vault: call /v1/unlock/start (creates the session) then
 * directly submit the passphrase to the UI route. Used to set up state
 * BEFORE running init — this mimics a user who has already created their vault.
 *
 * Takes the harness's rootToken so the bearer matches what the in-process
 * DaemonServer is checking against (the harness now uses a real 32-byte root
 * token instead of the hard-coded "test-token" string).
 */
async function bootstrapVault(
  ctx: { port: number; services: DaemonServices; rootToken: string },
  passphrase: string,
): Promise<void> {
  const { port, services, rootToken } = ctx;
  // Open a session (or get keychain fast-path).
  const startRes = await fetch(`http://127.0.0.1:${port}/v1/unlock/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${rootToken}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(startRes.status, 200, "unlock/start must succeed");
  const startBody = await startRes.json() as Record<string, unknown>;

  // If keychain fast-pathed → already unlocked, nothing more to do.
  if (startBody.unlocked === true) return;

  const sessionId = startBody.session_id as string;
  const session = services.unlockSessions.get(sessionId);
  assert.ok(session, "session must exist in store");

  const submitUrl = `http://127.0.0.1:${port}/ui/unlock/${sessionId}?token=${session.ui_token}`;
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase, set_passphrase: true }),
  });
  assert.equal(submitRes.status, 200, "passphrase submit must succeed");
}

/**
 * Poll services.unlockSessions until a session in "pending" state appears,
 * then submit the passphrase to it. Used to unblock init's poll loop when
 * init itself is the one that created the session via /v1/unlock/start.
 *
 * The poll retries every 20 ms for up to 5 seconds. Returns when the submit
 * succeeds.
 */
async function awaitAndSubmitPendingSession(
  port: number,
  services: DaemonServices,
  passphrase: string,
  setPassphrase: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // services.unlockSessions is a private Map — access via the public .get()
    // after finding session IDs from the store internals. We have no direct
    // iteration API, so we probe by observing when init calls /v1/unlock/start
    // and reading the session from the store afterward.
    //
    // Simpler: watch for any new session whose status is "pending" by checking
    // the (private) map field via bracket access.
    const store = services.unlockSessions as unknown as { map: Map<string, { id: string; ui_token: string; status: string }> };
    for (const [id, session] of store.map) {
      if (session.status === "pending") {
        const submitUrl = `http://127.0.0.1:${port}/ui/unlock/${id}?token=${session.ui_token}`;
        const submitRes = await fetch(submitUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passphrase, set_passphrase: setPassphrase }),
        });
        if (submitRes.status === 200) return;
        // If submit failed (race with another test), keep trying.
      }
    }
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error("awaitAndSubmitPendingSession: no pending session found within 5 s");
}

/**
 * Capture what initCommand().parseAsync() writes to process.stdout.
 * Returns the parsed JSON output object.
 */
async function runInit(args: string[] = []): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    return true;
  };
  try {
    const cmd = initCommand();
    // Commander exits on --help; suppress with exitOverride.
    cmd.exitOverride();
    await cmd.parseAsync(["node", "secret-shuttle", ...args]);
  } finally {
    process.stdout.write = origWrite;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return JSON.parse(raw) as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("init: daemon already running + vault already unlocked → fast no-op", async () => {
  const keychain = new MockKeychain();

  await withInitDaemon(async (ctx) => {
    // Bootstrap: create vault + unlock via passphrase UI.
    await bootstrapVault(ctx, "my-passphrase");

    // Vault is unlocked. Run init — should fast-path immediately.
    const result = await runInit(["--no-agent-install"]);
    assert.equal(result.ok, true);
    assert.equal(result.daemon_running, true);
    assert.equal(result.daemon_spawned, false);
    assert.equal(result.vault_initialized, true);
    // Vault already existed + was unlocked → not just created.
    assert.equal(result.vault_just_created, false);
    assert.equal(result.keychain_enrolled, false); // not just created → skip
    assert.deepEqual(result.agent_runtimes_detected, []);
    assert.equal(result.next_action, null);
  }, { keychain });
});

test("init: vault locked + keychain has key → keychain fast-path, no UI needed", async () => {
  const keychain = new MockKeychain();

  await withInitDaemon(async (ctx) => {
    // Bootstrap: create vault via passphrase UI; keychain entry gets written by C2.
    await bootstrapVault(ctx, "my-passphrase");

    // Re-lock the vault so init has to unlock it.
    ctx.services.lock.lock();
    assert.equal(ctx.services.lock.isUnlocked(), false);

    // Run init — keychain fast-path should unlock it.
    const result = await runInit(["--no-agent-install"]);
    assert.equal(result.ok, true);
    assert.equal(result.vault_initialized, true);
    assert.equal(result.vault_just_created, false);
    assert.equal(ctx.services.lock.isUnlocked(), true);
  }, { keychain });
});

test("init: --no-keychain skips keychain enrollment even when vault just created", async () => {
  // Use a keychain that starts empty (no entries) so unlock/start falls through
  // to the passphrase UI.
  //
  // Strategy: run init and awaitAndSubmitPendingSession concurrently. Init
  // calls /v1/unlock/start (creates a session), then polls /v1/unlock/poll.
  // The concurrent helper watches services.unlockSessions for a pending session
  // and submits the passphrase directly via the UI route.
  const keychain = new MockKeychain();
  keychain.entries.clear(); // no pre-existing entry → forces passphrase UI path

  await withInitDaemon(async (ctx) => {
    const submitPromise = awaitAndSubmitPendingSession(
      ctx.port, ctx.services, "my-passphrase", true,
    );
    const resultPromise = runInit(["--no-keychain", "--no-agent-install"]);
    const [result] = await Promise.all([resultPromise, submitPromise]);

    assert.equal(result.ok, true);
    assert.equal(result.vault_just_created, true);
    // --no-keychain: the explicit keychain/enable route must NOT have been called.
    assert.equal(result.keychain_enrolled, false);

    // P1.1: --no-keychain must persist the opt-out flag on the envelope so that
    // C2 opportunistic enrollment is also suppressed on future unlocks.
    const env = await readEnvelope();
    assert.ok(env !== null, "envelope must exist after init");
    assert.equal(env.keychain_opt_out, true, "keychain_opt_out must be true after --no-keychain");

    // Keychain entries must be empty (C2 was suppressed).
    assert.equal(keychain.entries.size, 0, "keychain must be empty after --no-keychain init");
  }, { keychain });
});

test("init: --no-agent-install skips skill writes", async () => {
  const keychain = new MockKeychain();

  await withInitDaemon(async (ctx) => {
    // Bootstrap: unlock vault (keychain fast-path via C2 enrollment).
    await bootstrapVault(ctx, "my-passphrase");

    // Create a fake .claude/ dir in ctx.home to trigger runtime detection
    // (but --no-agent-install should prevent writing anything).
    const fakeCwd = ctx.home;
    await mkdir(path.join(fakeCwd, ".claude"), { recursive: true });

    // Change cwd so detectAgentRuntimes sees .claude/.
    const origCwd = process.cwd();
    process.chdir(fakeCwd);
    try {
      const result = await runInit(["--no-agent-install"]);
      assert.equal(result.ok, true);
      assert.deepEqual(result.agent_runtimes_detected, []);
      // No skill file should be written.
      const skillPath = path.join(fakeCwd, ".claude/skills/secret-shuttle/SKILL.md");
      await assert.rejects(readFile(skillPath), /ENOENT/);
    } finally {
      process.chdir(origCwd);
    }
  }, { keychain });
});

test("init: agent runtime detected → skill file installed", async () => {
  const keychain = new MockKeychain();

  await withInitDaemon(async (ctx) => {
    // Bootstrap: unlock vault (keychain fast-path via C2 enrollment).
    await bootstrapVault(ctx, "my-passphrase");

    // Create a fake .claude/ dir to trigger runtime detection.
    const fakeCwd = ctx.home;
    await mkdir(path.join(fakeCwd, ".claude"), { recursive: true });

    const origCwd = process.cwd();
    process.chdir(fakeCwd);
    try {
      const result = await runInit(["--no-keychain"]);
      assert.equal(result.ok, true);
      // claude runtime should be detected.
      assert.ok(
        (result.agent_runtimes_detected as string[]).includes("claude"),
        "claude must be in agent_runtimes_detected",
      );
      // Skill file must exist (readBundledSkill succeeded + writeAgentFile ran).
      const skillPath = path.join(fakeCwd, ".claude/skills/secret-shuttle/SKILL.md");
      const content = await readFile(skillPath, "utf8");
      assert.ok(content.length > 0, "SKILL.md must be non-empty");
    } finally {
      process.chdir(origCwd);
    }
  }, { keychain });
});

// ── P1 post-ship: --no-keychain truly skips keychain during init run ─────────

test("init: --no-keychain does NOT read or write the master key during the init run (P1 post-ship)", async () => {
  // Track every keychain.set and keychain.get call to verify nothing touches
  // the keychain during a --no-keychain init run.
  const base = new MockKeychain();
  let setCalled = 0;
  let getCalled = 0;
  const counting: KeychainAdapter = {
    async isAvailable() { return base.isAvailable(); },
    async set(s: string, a: string, v: Buffer) { setCalled++; return base.set(s, a, v); },
    async get(s: string, a: string) { getCalled++; return base.get(s, a); },
    async delete(s: string, a: string) { return base.delete(s, a); },
  };

  await withInitDaemon(async (ctx) => {
    // No pre-existing vault. Run init with --no-keychain.
    const submitPromise = awaitAndSubmitPendingSession(
      ctx.port, ctx.services, "init-p1-passphrase", true,
    );
    const resultPromise = runInit(["--no-keychain", "--no-agent-install"]);
    const [result] = await Promise.all([resultPromise, submitPromise]);

    assert.equal(result.ok, true);
    assert.equal(result.vault_just_created, true);
    assert.equal(result.keychain_enrolled, false);

    // P1 core assertion: keychain.set was NEVER called (C2 suppressed from init run start).
    assert.equal(setCalled, 0, "keychain.set must NEVER be called during a --no-keychain init run (P1)");
    // C1 read was not attempted either.
    assert.equal(getCalled, 0, "keychain.get must NOT be called during a --no-keychain init run (P1)");

    // Envelope must have keychain_opt_out: true baked in from vault creation.
    const env = await readEnvelope();
    assert.ok(env !== null, "envelope must exist after init");
    assert.equal(env.keychain_opt_out, true, "keychain_opt_out must be true after --no-keychain");

    // Keychain must be completely empty.
    assert.equal(base.entries.size, 0, "keychain must be empty after --no-keychain init");
  }, { keychain: counting });
});

// ── A14: derive per-runtime agent_ids + write per-agent tokens ───────────────

/**
 * Recursively collect every file path under `dir`. Used to scan a project cwd
 * for any file that might leak the minted token bytes.
 */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test("init: derives the same agent_id for the same runtime across different cwds (no overwrite)", async () => {
  // Both project A and project B detect the "claude" runtime. We run init in A
  // first, capture the token from ~/.claude/settings.json (sandboxed userHome),
  // then chdir to project B and run init again. The token in ~/.claude/settings.json
  // must be unchanged — proving the agent_id is deterministic per-machine
  // (not per-cwd), so a different project does not overwrite the original token.
  const keychain = new MockKeychain();
  await withInitDaemon(async (ctx) => {
    await bootstrapVault(ctx, "my-passphrase");

    // Two project dirs, both with .claude/ so detectAgentRuntimes finds "claude".
    const projA = await mkdtemp(path.join(os.tmpdir(), "ss-init-projA-"));
    const projB = await mkdtemp(path.join(os.tmpdir(), "ss-init-projB-"));
    await mkdir(path.join(projA, ".claude"), { recursive: true });
    await mkdir(path.join(projB, ".claude"), { recursive: true });

    const settingsPath = path.join(ctx.userHome, ".claude", "settings.json");
    const origCwd = process.cwd();
    try {
      // Run init from project A.
      process.chdir(projA);
      const resultA = await runInit(["--no-keychain"]);
      assert.equal(resultA.ok, true);
      assert.deepEqual(resultA.agent_runtimes_configured, ["claude"]);

      const settingsA = JSON.parse(await readFile(settingsPath, "utf8")) as {
        env: Record<string, string>;
      };
      const tokenA = settingsA.env.SECRET_SHUTTLE_AGENT_TOKEN;
      assert.ok(typeof tokenA === "string" && tokenA.length > 0, "token must be present after init A");

      // Token shape is "<agent_id>.<hmac>". The agent_id must be the
      // deterministic derivation of the test's machine_id + "claude".
      const machineId = (await readFile(path.join(ctx.home, "machine-id"), "utf8")).trim();
      const expectedAgentId = deriveAutoAgentId("claude", machineId);
      assert.ok(
        tokenA.startsWith(`${expectedAgentId}.`),
        `token must start with ${expectedAgentId}.; got prefix ${tokenA.split(".")[0]}`,
      );

      // Run init again from project B (different cwd, SAME machine_id + root_token).
      process.chdir(projB);
      const resultB = await runInit(["--no-keychain"]);
      assert.equal(resultB.ok, true);

      const settingsB = JSON.parse(await readFile(settingsPath, "utf8")) as {
        env: Record<string, string>;
      };
      const tokenB = settingsB.env.SECRET_SHUTTLE_AGENT_TOKEN;
      // Deterministic per-machine: same machine_id + same root_token → same token.
      assert.equal(
        tokenB, tokenA,
        "claude token must be unchanged after re-running init from a different cwd",
      );
    } finally {
      process.chdir(origCwd);
      await rm(projA, { recursive: true, force: true });
      await rm(projB, { recursive: true, force: true });
    }
  }, { keychain });
});

test("init: writes SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1 alongside the token", async () => {
  // The token is useless on its own — the agent runtime needs to know it MUST
  // present an agent token (so a missing/cleared token fails closed instead of
  // silently degrading to root via the socket file). REQUIRE_AGENT_TOKEN=1 must
  // land in the same env block as the token.
  const keychain = new MockKeychain();
  await withInitDaemon(async (ctx) => {
    await bootstrapVault(ctx, "my-passphrase");

    const projDir = await mkdtemp(path.join(os.tmpdir(), "ss-init-require-"));
    await mkdir(path.join(projDir, ".claude"), { recursive: true });

    const origCwd = process.cwd();
    try {
      process.chdir(projDir);
      const result = await runInit(["--no-keychain"]);
      assert.equal(result.ok, true);

      const settingsPath = path.join(ctx.userHome, ".claude", "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        env: Record<string, string>;
      };
      assert.ok(
        typeof settings.env?.SECRET_SHUTTLE_AGENT_TOKEN === "string",
        "SECRET_SHUTTLE_AGENT_TOKEN must be set",
      );
      assert.equal(
        settings.env.SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN,
        "1",
        "SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN must be set to \"1\" alongside the token",
      );
    } finally {
      process.chdir(origCwd);
      await rm(projDir, { recursive: true, force: true });
    }
  }, { keychain });
});

test("init: claude config written to user-private path, NEVER repo-committed file", async () => {
  // After init runs in a project, walk the project cwd recursively and confirm
  // NO file contains the minted token bytes. The token must live ONLY in the
  // user-private ~/.claude/settings.json (sandboxed userHome here), never in
  // anything that could be accidentally committed.
  const keychain = new MockKeychain();
  await withInitDaemon(async (ctx) => {
    await bootstrapVault(ctx, "my-passphrase");

    const projDir = await mkdtemp(path.join(os.tmpdir(), "ss-init-noleak-"));
    await mkdir(path.join(projDir, ".claude"), { recursive: true });

    const origCwd = process.cwd();
    try {
      process.chdir(projDir);
      const result = await runInit(["--no-keychain"]);
      assert.equal(result.ok, true);

      // Grab the token from the user-private config.
      const settings = JSON.parse(
        await readFile(path.join(ctx.userHome, ".claude", "settings.json"), "utf8"),
      ) as { env: Record<string, string> };
      const token = settings.env.SECRET_SHUTTLE_AGENT_TOKEN;
      assert.ok(typeof token === "string" && token.length > 0, "token must be present");

      // Scan every file in projDir — none may contain the token bytes.
      const files = await walkFiles(projDir);
      for (const f of files) {
        const buf = await readFile(f);
        assert.equal(
          buf.includes(token),
          false,
          `token must NEVER appear in a file inside the project cwd; leaked into ${f}`,
        );
      }

      // Also confirm the user-private config really did receive it.
      const userPrivatePath = path.join(ctx.userHome, ".claude", "settings.json");
      const userPrivateBuf = await readFile(userPrivatePath, "utf8");
      assert.ok(
        userPrivateBuf.includes(token),
        "user-private settings.json must contain the token",
      );
      // And it lives OUTSIDE the project cwd.
      assert.ok(
        !userPrivatePath.startsWith(projDir),
        "user-private settings.json must be OUTSIDE the project cwd",
      );

      // File mode must be 0600 (user-only readable).
      const st = await stat(userPrivatePath);
      assert.equal(
        st.mode & 0o777, 0o600,
        `user-private settings.json must be mode 0600, got ${(st.mode & 0o777).toString(8)}`,
      );
    } finally {
      process.chdir(origCwd);
      await rm(projDir, { recursive: true, force: true });
    }
  }, { keychain });
});

test("init: pre-existing settings.json at 0644 is tightened to 0600 after token write (I2)", async () => {
  // Regression for the I2 reviewer finding: writeFile({ mode }) only sets the
  // mode at file CREATION. If ~/.claude/settings.json already exists at 0644
  // (e.g. from a prior install or a pre-existing user edit), the token write
  // silently leaves it 0644 — world-readable token. The fix adds an explicit
  // chmod(file, 0o600) after each writeFile.
  //
  // This test pre-creates a 0644 settings.json with existing non-Secret-Shuttle
  // JSON content, runs init, and asserts:
  //   1. The file is now 0600.
  //   2. The pre-existing JSON content was preserved (the spread merge works).
  const keychain = new MockKeychain();
  await withInitDaemon(async (ctx) => {
    await bootstrapVault(ctx, "my-passphrase");

    // Pre-create ~/.claude/settings.json (in the sandboxed userHome) with mode
    // 0644 + some unrelated keys init must NOT clobber.
    const settingsDir = path.join(ctx.userHome, ".claude");
    const settingsPath = path.join(settingsDir, "settings.json");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        env: { PRE_EXISTING_USER_KEY: "should-survive" },
        unrelated_top_level_key: { nested: "value" },
      }, null, 2),
      "utf8",
    );
    // writeFile defaults to 0666 & ~umask. Force 0644 explicitly so the test is
    // deterministic regardless of the developer's umask.
    await chmod(settingsPath, 0o644);
    const before = await stat(settingsPath);
    assert.equal(
      before.mode & 0o777, 0o644,
      `pre-condition: file must be 0644 before init runs; got ${(before.mode & 0o777).toString(8)}`,
    );

    // Run init in a project with .claude/ so the claude runtime is detected
    // and the token-install path triggers.
    const projDir = await mkdtemp(path.join(os.tmpdir(), "ss-init-chmod-"));
    await mkdir(path.join(projDir, ".claude"), { recursive: true });

    const origCwd = process.cwd();
    try {
      process.chdir(projDir);
      const result = await runInit(["--no-keychain"]);
      assert.equal(result.ok, true);
      assert.ok(
        (result.agent_runtimes_configured as string[]).includes("claude"),
        "claude must be configured (so the token-write path ran)",
      );

      // Core I2 assertion: the file mode is now 0600, NOT the original 0644.
      const after = await stat(settingsPath);
      assert.equal(
        after.mode & 0o777, 0o600,
        `pre-existing settings.json must be tightened to 0600 after init; got ${(after.mode & 0o777).toString(8)}`,
      );

      // Sanity: the spread-merge preserved both the pre-existing env key and
      // the unrelated top-level key (i.e. we tightened mode without clobbering
      // user content).
      const merged = JSON.parse(await readFile(settingsPath, "utf8")) as {
        env: Record<string, string>;
        unrelated_top_level_key: { nested: string };
      };
      assert.equal(
        merged.env.PRE_EXISTING_USER_KEY, "should-survive",
        "pre-existing env key must survive the merge",
      );
      assert.equal(
        merged.unrelated_top_level_key.nested, "value",
        "pre-existing top-level key must survive the merge",
      );
      assert.ok(
        typeof merged.env.SECRET_SHUTTLE_AGENT_TOKEN === "string",
        "init must still have written the new token alongside",
      );
      assert.equal(
        merged.env.SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN, "1",
        "init must still have written REQUIRE_AGENT_TOKEN=1 alongside",
      );
    } finally {
      process.chdir(origCwd);
      await rm(projDir, { recursive: true, force: true });
    }
  }, { keychain });
});

// I3 (cursor on Windows): the win32 branch in agent-token-installers.ts is
// structurally distinct from the darwin/linux branches — it resolves the file
// path via process.env.APPDATA (correct: %APPDATA%\Cursor\User\settings.json),
// uses envKey "terminal.integrated.env.windows", and falls back to manual
// instructions when APPDATA is unset. We do NOT execute it here because
// Object.defineProperty(process, "platform", ...) is brittle across Node
// versions and risks polluting global state for sibling tests. The branch is
// covered by code-review/spec-review; if it ever needs runtime coverage,
// extract installAgentToken into a unit test that injects platform + env.

test("init: codex/copilot get manual-install instructions in the summary, not config writes", async () => {
  // claude + copilot both detected → claude gets a config write, copilot gets a
  // manual-install instruction string in next_actions. The summary must
  // distinguish "configured" vs "pending_manual" so the user knows what they
  // still need to do by hand.
  const keychain = new MockKeychain();
  await withInitDaemon(async (ctx) => {
    await bootstrapVault(ctx, "my-passphrase");

    const projDir = await mkdtemp(path.join(os.tmpdir(), "ss-init-mixed-"));
    await mkdir(path.join(projDir, ".claude"), { recursive: true });
    await mkdir(path.join(projDir, ".github"), { recursive: true });
    await writeFile(
      path.join(projDir, ".github", "copilot-instructions.md"),
      "# pre-existing copilot instructions\n",
      "utf8",
    );

    const origCwd = process.cwd();
    try {
      process.chdir(projDir);
      const result = await runInit(["--no-keychain"]);
      assert.equal(result.ok, true);
      const detected = result.agent_runtimes_detected as string[];
      assert.ok(detected.includes("claude"), "claude detected");
      assert.ok(detected.includes("copilot"), "copilot detected");

      const configured = result.agent_runtimes_configured as string[];
      const pending = result.agent_runtimes_pending_manual as string[];
      assert.ok(configured.includes("claude"), "claude must be in agent_runtimes_configured");
      assert.ok(pending.includes("copilot"), "copilot must be in agent_runtimes_pending_manual");
      assert.equal(
        configured.includes("copilot"), false,
        "copilot must NOT be in agent_runtimes_configured",
      );

      const nextActions = result.next_actions as string[];
      assert.ok(
        nextActions.some((s) => s.includes("copilot") && s.includes("SECRET_SHUTTLE_AGENT_TOKEN")),
        `next_actions must include a copilot manual-install instruction; got: ${JSON.stringify(nextActions)}`,
      );
    } finally {
      process.chdir(origCwd);
      await rm(projDir, { recursive: true, force: true });
    }
  }, { keychain });
});

// ── T1: per-runtime mint failure must not halt the loop ──────────────────────

test("init: one runtime's /v1/tokens/mint failure does not halt the others; summary lists the failure", async () => {
  // Injection strategy: Option A — re-register POST /v1/tokens/mint AFTER
  // registerTokens has already run inside the harness. DaemonServer keeps
  // routes in a Map (`this.routes.set(...)`), so the second addRoute() call
  // overwrites the prior handler with a test-controlled one-shot-fail variant.
  //
  // The fake handler throws ShuttleError("agent_token_invalid", ...) on its
  // FIRST call, then returns a valid token for every subsequent call. With
  // two detected runtimes (claude + copilot, alphabetical order), this means
  // claude's mint fails and copilot's mint succeeds — proving the loop kept
  // going past the failure and emitted a structured summary.
  const keychain = new MockKeychain();
  await withInitDaemon(async (ctx) => {
    await bootstrapVault(ctx, "my-passphrase");

    const projDir = await mkdtemp(path.join(os.tmpdir(), "ss-init-failure-"));
    await mkdir(path.join(projDir, ".claude"), { recursive: true });
    await mkdir(path.join(projDir, ".github"), { recursive: true });
    await writeFile(
      path.join(projDir, ".github", "copilot-instructions.md"),
      "# pre-existing copilot instructions\n",
      "utf8",
    );

    // One-shot-fail handler. Overwrites the handler registered by
    // registerTokens() inside the harness.
    let failed = false;
    ctx.server.addRoute("POST", "/v1/tokens/mint", (_req, raw) => {
      if (!failed) {
        failed = true;
        throw new ShuttleError("agent_token_invalid", "synthetic test failure");
      }
      const o = raw as { agent_id: string };
      const hmac = deriveHmac(ctx.rootToken, o.agent_id);
      return { token: formatBearer(o.agent_id, hmac), agent_id: o.agent_id };
    });

    const origCwd = process.cwd();
    process.chdir(projDir);
    try {
      const result = await runInit(["--no-keychain"]);

      // Init MUST still emit a summary (no stack trace, no early exit).
      assert.equal(result.ok, true, "init must still emit a summary on partial failure");

      // agent_runtimes_failed must contain exactly one entry — the runtime
      // whose mint threw on its first call.
      //
      // Each entry must carry { runtime, error_code, message, hint } so the
      // partial-failure summary is actionable without cross-referencing the
      // registry. The summary must also carry partial_failure: true so new
      // readers don't have to inspect failed[].length themselves.
      const runtimesFailed = result.agent_runtimes_failed as
        | Array<{ runtime: string; error_code: string; message: string; hint: string | null }>
        | undefined;
      assert.ok(
        Array.isArray(runtimesFailed) && runtimesFailed.length === 1,
        `agent_runtimes_failed must have exactly 1 entry, got: ${JSON.stringify(runtimesFailed)}`,
      );
      assert.equal(runtimesFailed![0]!.error_code, "agent_token_invalid");
      assert.equal(
        typeof runtimesFailed![0]!.message,
        "string",
        "failed entry must include a string message",
      );
      assert.ok(
        runtimesFailed![0]!.message.length > 0,
        "failed entry message must be non-empty",
      );
      // hint comes from the registry: agent_token_invalid has a string hint.
      // The contract is "string OR null" — accept both shapes.
      const hint = runtimesFailed![0]!.hint;
      assert.ok(
        hint === null || typeof hint === "string",
        `failed entry hint must be string or null, got: ${JSON.stringify(hint)}`,
      );
      assert.equal(
        result.partial_failure,
        true,
        "summary must set partial_failure: true when failed[] is non-empty",
      );

      // Both runtimes must still be detected even after one failure.
      const detected = result.agent_runtimes_detected as string[];
      assert.equal(detected.length, 2, "both runtimes must still be detected even after one failure");
      assert.ok(detected.includes("claude") && detected.includes("copilot"), "claude + copilot must be detected");

      // The non-failing runtime must still appear in configured OR
      // pending_manual — proving the loop kept going past the failure.
      const configured = result.agent_runtimes_configured as string[];
      const pending = result.agent_runtimes_pending_manual as string[];
      assert.equal(
        configured.length + pending.length,
        1,
        `exactly one runtime must have a successful outcome (configured or pending_manual); got configured=${JSON.stringify(configured)} pending=${JSON.stringify(pending)}`,
      );
    } finally {
      process.chdir(origCwd);
      await rm(projDir, { recursive: true, force: true });
    }
  }, { keychain });
});

// ── Burst 7 §1 (Plan 5s): --per-project-identity opt-in resolution ───────────
//
// Asserts the flag's CONFIG side effect + the opt-in resolution, without
// requiring a live daemon. The agent-id derivation itself is covered by
// agent-id.test.ts; here we pin that the flag (1) persists the opt-in and
// (2) preserves infer.*.

test("init --per-project-identity: flag true OR config true ⇒ opt-in; writes config preserving infer.*", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-init-ppi-"));
  try {
    await writeFile(
      path.join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ infer: { supabaseNames: ["DATABASE_SERVICE_KEY"] } }),
    );
    // Flag set ⇒ resolves true AND persists the opt-in.
    const optedIn = await resolvePerProjectOptIn({ cwd: dir, flag: true });
    assert.equal(optedIn, true);
    assert.equal(await loadIdentityPerProject(dir), true, "flag persisted into config");
    const parsed = JSON.parse(await readFile(path.join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.deepEqual(parsed.infer, { supabaseNames: ["DATABASE_SERVICE_KEY"] }, "infer.* preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init: no flag + no config ⇒ opt-out (2-arg derivation path)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-init-ppi-off-"));
  try {
    assert.equal(await resolvePerProjectOptIn({ cwd: dir, flag: false }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init: no flag + config perProject:true ⇒ opt-in (config is canonical, no re-write needed)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-init-ppi-cfg-"));
  try {
    await writeFile(path.join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: true } }));
    assert.equal(await resolvePerProjectOptIn({ cwd: dir, flag: false }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --per-project-identity: persists the opt-in even with zero detected runtimes (records intent for a later init)", async () => {
  // The opt-in is resolved once BEFORE the per-runtime mint loop, so the flag
  // records intent into the canonical config even when no agent runtime is
  // present yet (no token is minted). A later init — after the user adds
  // .claude/ etc. — then honors the persisted opt-in.
  const dir = await mkdtemp(path.join(os.tmpdir(), "ss-init-ppi-noruntime-"));
  try {
    // No .claude/.cursor/etc. in this bare dir ⇒ zero runtimes.
    const optedIn = await resolvePerProjectOptIn({ cwd: dir, flag: true });
    assert.equal(optedIn, true, "flag opts in regardless of runtime detection");
    assert.equal(
      await loadIdentityPerProject(dir),
      true,
      "opt-in persisted to config even though no token was minted",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
