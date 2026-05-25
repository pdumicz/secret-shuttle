import { stat } from "node:fs/promises";
import path from "node:path";

export type AgentRuntime = "claude" | "codex" | "cursor" | "copilot";

interface RuntimeCheck {
  runtime: AgentRuntime;
  relPath: string;
}

const CHECKS: RuntimeCheck[] = [
  { runtime: "claude", relPath: ".claude" },
  { runtime: "codex", relPath: "AGENTS.md" },
  { runtime: "cursor", relPath: ".cursor" },
  { runtime: "copilot", relPath: ".github/copilot-instructions.md" },
];

/**
 * Detect agent-runtime conventions present in `cwd`. Returns the runtimes
 * found, sorted alphabetically.
 *
 *   claude   ← `.claude/` directory
 *   codex    ← `AGENTS.md` file at the root
 *   cursor   ← `.cursor/` directory
 *   copilot  ← `.github/copilot-instructions.md`
 *
 * Used by `secret-shuttle init` to install Secret Shuttle's skill into
 * every detected runtime. `stat` is used (not `access`) so the detection
 * is type-agnostic — both files and directories satisfy "present".
 */
export async function detectAgentRuntimes(cwd: string): Promise<AgentRuntime[]> {
  const found: AgentRuntime[] = [];
  for (const { runtime, relPath } of CHECKS) {
    try {
      await stat(path.join(cwd, relPath));
      found.push(runtime);
    } catch {
      // Not present; skip.
    }
  }
  return found.sort();
}
