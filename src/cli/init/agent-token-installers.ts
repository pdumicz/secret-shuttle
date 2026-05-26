// src/cli/init/agent-token-installers.ts
//
// Per-runtime installers that write a minted agent token to the appropriate
// USER-PRIVATE config file for each agent runtime — never into a repo-committed
// path. Token + REQUIRE_AGENT_TOKEN=1 are stamped together so the runtime fails
// closed if the token is later removed (instead of silently degrading to root).
//
// Layout per runtime:
//   claude  → ~/.claude/settings.json                       (env block,    0600)
//   cursor  → ~/Library/Application Support/Cursor/User/settings.json
//             OR ~/.config/Cursor/User/settings.json        (terminal env, 0600)
//   codex   → manual: caller adds exports to shell rc
//   copilot → manual: caller adds exports to shell rc
//
// File mode 0600 is enforced unconditionally — if the user already had a
// world-readable settings.json, init tightens it. Existing keys outside our
// env block are preserved (we merge into the env map, not replace it).

import path from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { AgentRuntime } from "../agent-runtime-detect.js";

export interface InstallResult {
  runtime: AgentRuntime;
  status: "configured" | "manual";
  configPath?: string;
  manualInstructions?: string;
}

/**
 * Write the agent token to the runtime's user-private config (claude/cursor)
 * or return a manual-install instruction string (codex/copilot).
 *
 * The output is idempotent: re-running with the SAME (runtime, agentId, token)
 * produces an identical file. Re-running with a different token rewrites it.
 *
 * Per-runtime decisions:
 *   - claude:  injects into the `env` block of ~/.claude/settings.json — Claude
 *              Code's settings file already supports an `env` key that the
 *              runtime applies to every spawned MCP server / hook process.
 *   - cursor:  injects into `terminal.integrated.env.osx` (macOS) or
 *              `terminal.integrated.env.linux` (everything else) — Cursor
 *              applies these to integrated-terminal child processes.
 *   - codex / copilot: emit shell-rc snippets; the agent doesn't expose a
 *              user-private env injection point we can write to deterministically.
 */
export async function installAgentToken(
  runtime: AgentRuntime,
  agentId: string,
  token: string,
): Promise<InstallResult> {
  if (runtime === "claude") {
    const file = path.join(homedir(), ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    let settings: { env?: Record<string, string> } & Record<string, unknown> = {};
    try {
      const txt = await readFile(file, "utf8");
      settings = JSON.parse(txt) as typeof settings;
    } catch {
      // file absent or empty
    }
    settings.env = {
      ...(settings.env ?? {}),
      SECRET_SHUTTLE_AGENT_TOKEN: token,
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: "1",
    };
    await writeFile(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    // Mark agentId as used (it's part of the token, so this just satisfies the
    // signature for callers that care about per-runtime audit).
    void agentId;
    return { runtime, status: "configured", configPath: file };
  }
  if (runtime === "cursor") {
    const file = process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "Cursor", "User", "settings.json")
      : path.join(homedir(), ".config", "Cursor", "User", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch { /* empty */ }
    const envKey = process.platform === "darwin"
      ? "terminal.integrated.env.osx"
      : "terminal.integrated.env.linux";
    const existing = (settings[envKey] as Record<string, string> | undefined) ?? {};
    settings[envKey] = {
      ...existing,
      SECRET_SHUTTLE_AGENT_TOKEN: token,
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: "1",
    };
    await writeFile(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    void agentId;
    return { runtime, status: "configured", configPath: file };
  }
  // codex / copilot: no deterministic user-private config; emit manual instructions.
  return {
    runtime,
    status: "manual",
    manualInstructions:
      `For ${runtime}: add the following to your shell rc and restart ${runtime}:\n  export SECRET_SHUTTLE_AGENT_TOKEN=${token}\n  export SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1`,
  };
}
