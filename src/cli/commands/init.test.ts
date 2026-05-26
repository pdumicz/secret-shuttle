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
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServer } from "../../daemon/server.js";
import { DaemonServices } from "../../daemon/services.js";
import { registerHealth } from "../../daemon/api/routes/health.js";
import { registerUnlockSession } from "../../daemon/api/routes/unlock-session.js";
import { registerKeychainRoutes } from "../../daemon/api/routes/keychain.js";
import { writeSocketFile } from "../../daemon/socket-file.js";
import { readEnvelope } from "../../vault/envelope.js";
import { initCommand } from "./init.js";
import type { KeychainAdapter } from "../../vault/keychain/types.js";

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
  async hasEntry(service: string, account: string): Promise<boolean> {
    if (!this.available) return false;
    return this.entries.has(`${service}:${account}`);
  }
}

// ── Shared harness ────────────────────────────────────────────────────────────

interface HarnessCtx {
  port: number;
  services: DaemonServices;
  home: string;
}

async function withInitDaemon<T>(
  fn: (ctx: HarnessCtx) => Promise<T>,
  opts: { keychain?: KeychainAdapter } = {},
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-init-test-"));
  const prevHome = process.env.SECRET_SHUTTLE_HOME;
  const prevDev = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  // ensureDaemonRunning() checks readSocketFile() first. We pre-write the
  // socket file before the init action runs, so the spawn path is never taken
  // — the function sees an existing socket and returns { daemonSpawned: false }.
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";

  const server = new DaemonServer({ token: "test-token" });
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
  ({ port } = await server.listen(0));

  // Write the socket file so daemonRequest() can find the test server.
  await mkdir(home, { recursive: true });
  await writeSocketFile({ port, token: "test-token", pid: process.pid });

  try {
    return await fn({ port, services, home });
  } finally {
    await server.close();
    if (prevHome === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prevHome;
    if (prevDev === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevDev;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Bootstrap the vault: call /v1/unlock/start (creates the session) then
 * directly submit the passphrase to the UI route. Used to set up state
 * BEFORE running init — this mimics a user who has already created their vault.
 */
async function bootstrapVault(
  port: number,
  services: DaemonServices,
  passphrase: string,
): Promise<void> {
  // Open a session (or get keychain fast-path).
  const startRes = await fetch(`http://127.0.0.1:${port}/v1/unlock/start`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
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
    await bootstrapVault(ctx.port, ctx.services, "my-passphrase");

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
    await bootstrapVault(ctx.port, ctx.services, "my-passphrase");

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
    await bootstrapVault(ctx.port, ctx.services, "my-passphrase");

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
    await bootstrapVault(ctx.port, ctx.services, "my-passphrase");

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
