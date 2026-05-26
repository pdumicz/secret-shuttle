// src/cli/init/agent-token-installers.ts
//
// Per-runtime installers that write a minted agent token to the appropriate
// USER-PRIVATE config file for each agent runtime — never into a repo-committed
// path. Token + REQUIRE_AGENT_TOKEN=1 are stamped together so the runtime fails
// closed if the token is later removed (instead of silently degrading to root).
//
// Layout per runtime:
//   claude  → ~/.claude/settings.json                                  (env block,    0600)
//   cursor  → ~/Library/Application Support/Cursor/User/settings.json  (darwin)
//             OR %APPDATA%\Cursor\User\settings.json                   (win32)
//             OR ~/.config/Cursor/User/settings.json                   (linux/other,  terminal env, 0600)
//   codex   → manual: caller adds exports to shell rc
//   copilot → manual: caller adds exports to shell rc
//
// File mode 0600 is enforced unconditionally — if the user already had a
// world-readable settings.json, init tightens it. Existing keys outside our
// env block are preserved (we merge into the env map, not replace it).

import path from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
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
 *   - cursor:  injects into `terminal.integrated.env.osx` (macOS),
 *              `terminal.integrated.env.windows` (Windows, %APPDATA%\Cursor),
 *              or `terminal.integrated.env.linux` (linux/other) — Cursor
 *              applies these to integrated-terminal child processes. On
 *              Windows without APPDATA we refuse and return manual
 *              instructions; writing to ~/.config/Cursor on Windows is a
 *              silent no-op because Cursor doesn't read from there.
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
    // writeFile's { mode } only applies when the file is CREATED. If the file
    // already exists with a wider mode (e.g. 0644 from a prior install), the
    // mode is NOT tightened. Re-chmod unconditionally so the header-comment
    // promise ("mode 0600 is enforced unconditionally") actually holds.
    await chmod(file, 0o600);
    // Mark agentId as used (it's part of the token, so this just satisfies the
    // signature for callers that care about per-runtime audit).
    void agentId;
    return { runtime, status: "configured", configPath: file };
  }
  if (runtime === "cursor") {
    // 3-way platform resolution. Previously we collapsed win32 into the
    // "everything else" (linux) branch, which:
    //   1. Wrote to ~/.config/Cursor/... on Windows — Cursor on Windows reads
    //      from %APPDATA%\Cursor\User\settings.json, so the env vars were
    //      silently dropped and REQUIRE_AGENT_TOKEN=1 never took effect.
    //   2. Used envKey "terminal.integrated.env.linux" — wrong key for
    //      Cursor-on-Windows even if the path had been right.
    let file: string;
    let envKey: string;
    if (process.platform === "darwin") {
      file = path.join(homedir(), "Library", "Application Support", "Cursor", "User", "settings.json");
      envKey = "terminal.integrated.env.osx";
    } else if (process.platform === "win32") {
      const appData = process.env.APPDATA;
      if (appData === undefined || appData === "") {
        // Refuse — fall back to manual instructions rather than guess. A wrong
        // path here would leave the user thinking REQUIRE_AGENT_TOKEN=1 is in
        // effect when in fact Cursor never reads the file.
        return {
          runtime,
          status: "manual",
          manualInstructions:
            `For cursor on Windows: APPDATA is not set. Add the following to your shell environment manually:\n  set SECRET_SHUTTLE_AGENT_TOKEN=${token}\n  set SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN=1\nOr write to %APPDATA%\\Cursor\\User\\settings.json with "terminal.integrated.env.windows".`,
        };
      }
      file = path.join(appData, "Cursor", "User", "settings.json");
      envKey = "terminal.integrated.env.windows";
    } else {
      file = path.join(homedir(), ".config", "Cursor", "User", "settings.json");
      envKey = "terminal.integrated.env.linux";
    }
    await mkdir(path.dirname(file), { recursive: true });
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch { /* empty */ }
    const existing = (settings[envKey] as Record<string, string> | undefined) ?? {};
    settings[envKey] = {
      ...existing,
      SECRET_SHUTTLE_AGENT_TOKEN: token,
      SECRET_SHUTTLE_REQUIRE_AGENT_TOKEN: "1",
    };
    await writeFile(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
    // Same rationale as the claude branch: re-chmod unconditionally so an
    // existing wide-mode settings.json is tightened to 0600.
    await chmod(file, 0o600);
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
