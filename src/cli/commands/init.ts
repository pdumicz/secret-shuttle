import { Command } from "commander";
import { startDaemon } from "../../daemon/lifecycle.js";
import { readSocketFile } from "../../daemon/socket-file.js";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { ShuttleError } from "../../shared/errors.js";
import { detectAgentRuntimes, type AgentRuntime } from "../agent-runtime-detect.js";
import { agentInstallTarget, readBundledSkill } from "./agent.js";
import { getSecretShuttleHome } from "../../shared/config.js";
import { readMachineId } from "../../daemon/machine-id.js";
import { deriveAutoAgentId } from "../../daemon/auth/agent-id.js";
import { installAgentToken, type InstallResult } from "../init/agent-token-installers.js";

interface HealthResponse {
  daemon: boolean;
  unlocked: boolean;
  vault: { envelope_present: boolean };
}

// Returned by /v1/unlock/start. Two possible shapes:
//   - Keychain fast-path: { unlocked: true, source: "keychain" }
//   - Passphrase UI flow: { session_id: string, requires_create: boolean, expires_at: number }
interface UnlockStartResponse {
  unlocked?: boolean;
  source?: string;
  session_id?: string;
  requires_create?: boolean;
  expires_at?: number;
}

const UNLOCK_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 300;

/**
 * Ensure the daemon is running. Delegates entirely to startDaemon() which
 * already handles three cases:
 *   1. Daemon is running and alive → returns existing socket (no spawn).
 *   2. Socket file is stale (PID not alive) → removes it, spawns fresh.
 *   3. No socket file → spawns fresh.
 *
 * Using startDaemon() here prevents the previous bug where init returned a
 * stale port from a crashed daemon, causing subsequent HTTP requests to fail.
 *
 * Returns { daemonSpawned, port }.
 */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function ensureDaemonRunning(): Promise<{ daemonSpawned: boolean; port: number }> {
  // Check the pre-spawn state so we can set daemonSpawned accurately.
  // startDaemon() is idempotent and handles stale-socket cleanup internally.
  const priorSocket = await readSocketFile();
  const alreadyAlive = priorSocket !== null && pidAlive(priorSocket.pid);
  const sf = await startDaemon();
  return { daemonSpawned: !alreadyAlive, port: sf.port };
}

/**
 * Ensure the vault exists and is unlocked.
 *
 * - If the vault already exists and is unlocked: returns false (nothing done).
 * - If the vault exists but is locked: opens the passphrase UI (same as
 *   `secret-shuttle unlock`), polls until unlocked, returns false (existing vault).
 * - If no vault exists: opens the passphrase UI with create=1 so the user
 *   creates the vault, polls until unlocked, returns true (just created).
 *
 * Throws unlock_timeout after 2 minutes if the user does not complete the UI.
 */
async function ensureVaultUnlocked(opts: { skipKeychain: boolean } = { skipKeychain: false }): Promise<boolean> {
  const health = await daemonRequest<HealthResponse>("GET", "/v1/health");

  // Already unlocked — nothing to do.
  if (health.unlocked) {
    return false; // vault existed (or was just created and already unlocked)
  }

  const vaultExistedBefore = health.vault.envelope_present;

  // POST /v1/unlock/start:
  //   - If the envelope exists AND keychain has the key → returns { unlocked: true, source: "keychain" }
  //   - Otherwise → opens the browser UI and returns { session_id, requires_create }
  //
  // P1 post-ship fix: pass skip_keychain when the caller has --no-keychain so
  // the daemon skips both the C1 keychain read and the C2 opportunistic write
  // DURING THIS VERY REQUEST — not just on future runs. Without this flag, the
  // keychain could be written (briefly) before /v1/keychain/disable cleaned it up.
  const startResp = await daemonRequest<UnlockStartResponse>("POST", "/v1/unlock/start", {
    skip_keychain: opts.skipKeychain,
  });

  // Keychain fast-path: daemon already unlocked the vault.
  if (startResp.unlocked === true) {
    return !vaultExistedBefore; // true only if the vault was just created
  }

  // Passphrase UI flow: poll until the user submits the passphrase in the browser.
  if (typeof startResp.session_id !== "string") {
    throw new ShuttleError(
      "unlock_session_not_found",
      "Unexpected response from /v1/unlock/start — missing both session_id and unlocked flag.",
    );
  }

  const sessionId = startResp.session_id;
  const vaultJustCreated = startResp.requires_create === true;

  process.stderr.write(
    vaultJustCreated
      ? "No vault found. Secret Shuttle is opening the setup window in your browser — create your passphrase there.\n"
      : "Vault locked. Opening the unlock window in your browser.\n",
  );

  const deadline = Date.now() + UNLOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await daemonRequest<{ status: string }>("POST", "/v1/unlock/poll", {
      session_id: sessionId,
    });
    if (poll.status === "unlocked") {
      return vaultJustCreated;
    }
    if (poll.status === "failed") {
      throw new ShuttleError(
        "vault_unlock_failed",
        "Vault setup/unlock failed in the browser UI.",
      );
    }
    // status === "pending" → keep polling
  }
  throw new ShuttleError(
    "unlock_timeout",
    "Vault setup/unlock not completed (passphrase UI was not submitted within 2 minutes).",
  );
}

/**
 * Try to enroll the OS keychain. Silently skips if:
 *   - keychain is unavailable on this platform/environment
 *   - vault is not unlocked (shouldn't happen — called after ensureVaultUnlocked)
 *
 * Returns true if enrolled successfully, false if skipped.
 */
async function maybeEnrollKeychain(): Promise<boolean> {
  try {
    const r = await daemonRequest<{ enrolled: boolean }>("POST", "/v1/keychain/enable");
    return r.enrolled;
  } catch (e) {
    if (
      e instanceof ShuttleError &&
      (e.code === "keychain_unavailable" || e.code === "vault_locked")
    ) {
      return false; // platform doesn't support it, or unexpected lock state; skip silently
    }
    throw e;
  }
}

/**
 * Detect agent runtimes in `cwd` and install the Secret Shuttle skill into
 * each one. Returns the list of runtimes that were detected (installed).
 */
async function installAgentSkills(cwd: string): Promise<AgentRuntime[]> {
  const detected = await detectAgentRuntimes(cwd);
  if (detected.length === 0) return [];
  const skillContent = await readBundledSkill();
  for (const runtime of detected) {
    await agentInstallTarget(runtime, { skillContent, cwd });
  }
  return detected;
}

export function initCommand(): Command {
  return new Command("init")
    .description(
      "First-run setup: start daemon, create vault, enroll keychain (Touch ID), install agent skills.",
    )
    .option("--no-keychain", "Skip OS keychain enrollment (passphrase unlock only).")
    .option("--no-agent-install", "Skip detecting + installing agent skill files.")
    .action(async (options: { keychain?: boolean; agentInstall?: boolean }) => {
      // Step 1: Ensure daemon is running (spawn if absent).
      const { daemonSpawned, port } = await ensureDaemonRunning();

      // Step 2: Ensure vault exists and is unlocked (open passphrase UI if needed).
      // Pass skipKeychain so the daemon never touches the keychain during a
      // --no-keychain init run — not just on future runs (P1 post-ship fix).
      const vaultJustCreated = await ensureVaultUnlocked({ skipKeychain: options.keychain === false });

      // Step 3a: If --no-keychain was passed, persist the opt-out on the envelope
      // so that the C2 opportunistic enrollment (which runs during the passphrase
      // UI submit) is also suppressed on future unlocks. This calls
      // /v1/keychain/disable which writes keychain_opt_out: true to the envelope
      // and deletes any existing keychain entry — idempotent.
      if (options.keychain === false) {
        await daemonRequest("POST", "/v1/keychain/disable");
      }

      // Step 3b: Keychain enrollment — only if vault was just created AND --no-keychain
      // not set. Skip silently on unavailable platforms.
      const keychainEnrolled =
        options.keychain !== false && vaultJustCreated
          ? await maybeEnrollKeychain()
          : false;

      // Step 4: Agent skill installation — detect runtimes in cwd and install.
      const runtimes: AgentRuntime[] =
        options.agentInstall !== false
          ? await installAgentSkills(process.cwd())
          : [];

      // Step 5: Per-runtime agent_id derivation + token mint + write to USER-
      // PRIVATE runtime config. Each detected runtime gets its own deterministic
      // agent_id (per-(machine_id, runtime) — same machine produces the same id
      // across different cwds, so the token written to the global config does
      // not collide between projects). Tokens NEVER land in repo-committed files.
      //
      // Read machine_id directly via readMachineId (set during daemon bootstrap by
      // ensureMachineId). The init CLI runs as the same user as the daemon, so the
      // 0600 file is readable. If machine_id is somehow absent (daemon not started
      // by us this run + never started before), we skip the per-runtime token
      // install rather than crash — the agent_runtimes_detected list is still
      // emitted so the user can re-run init after the daemon writes the file.
      const configured: string[] = [];
      const pendingManual: string[] = [];
      const nextActions: string[] = [];
      if (runtimes.length > 0) {
        const machineId = await readMachineId(getSecretShuttleHome());
        if (machineId !== null) {
          // TODO(post-launch): if one runtime's mint fails, accumulate the failure
          // into `agent_runtimes_failed: [{runtime, error_code}]` and continue with
          // the others. Currently a mid-loop failure halts init with a stack trace
          // and leaves partial state. Tracked as a Phase-B follow-up.
          for (const runtime of runtimes) {
            const agentId = deriveAutoAgentId(runtime, machineId);
            const { token } = await daemonRequest<{ token: string; agent_id: string }>(
              "POST",
              "/v1/tokens/mint",
              { agent_id: agentId },
            );
            const result: InstallResult = await installAgentToken(runtime, agentId, token);
            if (result.status === "configured") {
              configured.push(runtime);
            } else {
              pendingManual.push(runtime);
              if (result.manualInstructions !== undefined) {
                nextActions.push(result.manualInstructions);
              }
            }
          }
        }
      }

      // Step 6: Emit summary.
      outputJson(
        ok({
          daemon_running: true,
          daemon_port: port,
          daemon_spawned: daemonSpawned,
          vault_initialized: true,
          vault_just_created: vaultJustCreated,
          keychain_enrolled: keychainEnrolled,
          agent_runtimes_detected: runtimes,
          agent_runtimes_configured: configured,
          agent_runtimes_pending_manual: pendingManual,
          next_actions: nextActions,
          next_action: vaultJustCreated
            ? "secret-shuttle import --env-file .env  # optional: migrate existing secrets"
            : null,
        }),
      );
    })
    .addHelpText(
      "after",
      `
Examples:
  # First-run setup (creates vault, enrolls Touch ID, installs agent skills):
  secret-shuttle init

  # Skip keychain enrollment (passphrase unlock only):
  secret-shuttle init --no-keychain

  # Skip agent skill install:
  secret-shuttle init --no-agent-install
`,
    );
}
