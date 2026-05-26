import { Command } from "commander";
import { startDaemon } from "../../daemon/lifecycle.js";
import { readSocketFile } from "../../daemon/socket-file.js";
import { daemonRequest } from "../../client/daemon-client.js";
import { ok, outputJson } from "../../shared/result.js";
import { ShuttleError } from "../../shared/errors.js";
import { detectAgentRuntimes, type AgentRuntime } from "../agent-runtime-detect.js";
import { agentInstallTarget, readBundledSkill } from "./agent.js";

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
 * Ensure the daemon is running. If a socket file already exists, return the
 * port without spawning. Otherwise call startDaemon() which handles spawn +
 * wait-for-socket internally (15 s timeout, throws daemon_start_timeout on
 * failure).
 *
 * Returns { daemonSpawned, port }.
 */
async function ensureDaemonRunning(): Promise<{ daemonSpawned: boolean; port: number }> {
  const existing = await readSocketFile();
  if (existing !== null) {
    return { daemonSpawned: false, port: existing.port };
  }
  // startDaemon() is idempotent (returns existing if running) and handles the
  // full spawn + poll-for-socket cycle with a 15 s timeout.
  const sf = await startDaemon();
  return { daemonSpawned: true, port: sf.port };
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
async function ensureVaultUnlocked(): Promise<boolean> {
  const health = await daemonRequest<HealthResponse>("GET", "/v1/health");

  // Already unlocked — nothing to do.
  if (health.unlocked) {
    return false; // vault existed (or was just created and already unlocked)
  }

  const vaultExistedBefore = health.vault.envelope_present;

  // POST /v1/unlock/start:
  //   - If the envelope exists AND keychain has the key → returns { unlocked: true, source: "keychain" }
  //   - Otherwise → opens the browser UI and returns { session_id, requires_create }
  const startResp = await daemonRequest<UnlockStartResponse>("POST", "/v1/unlock/start");

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
      const vaultJustCreated = await ensureVaultUnlocked();

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

      // Step 5: Emit summary.
      outputJson(
        ok({
          daemon_running: true,
          daemon_port: port,
          daemon_spawned: daemonSpawned,
          vault_initialized: true,
          vault_just_created: vaultJustCreated,
          keychain_enrolled: keychainEnrolled,
          agent_runtimes_detected: runtimes,
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
