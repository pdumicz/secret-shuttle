import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ShuttleError } from "../../shared/errors.js";
import { writeAgentFile, writeAgentSnippet } from "../agent-writer.js";
import { deriveSkillUrl, type RepositoryField } from "../skill-url.js";

const BEGIN_MARKER = "<!-- secret-shuttle:begin -->";
const END_MARKER = "<!-- secret-shuttle:end -->";

export type AgentTarget = "claude" | "codex" | "cursor" | "copilot";

interface TargetSpec {
  /** Destination path relative to cwd. */
  destPath: string;
  /** Write mode. */
  mode: "wholesale" | "snippet";
}

const TARGETS: Record<AgentTarget, TargetSpec> = {
  claude:  { destPath: ".claude/skills/secret-shuttle/SKILL.md", mode: "wholesale" },
  codex:   { destPath: "AGENTS.md",                              mode: "snippet"   },
  cursor:  { destPath: ".cursor/rules/secret-shuttle.mdc",       mode: "wholesale" },
  copilot: { destPath: ".github/copilot-instructions.md",        mode: "snippet"   },
};

/**
 * Resolves the package's bundled SKILL.md. When running from the built
 * dist/cli/commands/agent.js, the package root is two levels up.
 * Falls back to walking up four levels for source-mode invocation.
 */
async function readBundledSkill(): Promise<string> {
  const here = fileURLToPath(import.meta.url);
  // .../dist/cli/commands/agent.js → walk up to package root then into skills/
  const candidates = [
    path.resolve(path.dirname(here), "..", "..", "..", "skills", "secret-shuttle", "SKILL.md"),
    path.resolve(path.dirname(here), "..", "..", "skills", "secret-shuttle", "SKILL.md"),
  ];
  for (const c of candidates) {
    try { return await readFile(c, "utf8"); } catch { /* try next */ }
  }
  throw new ShuttleError(
    "skill_bundled_file_missing",
    "Could not locate the bundled skills/secret-shuttle/SKILL.md. Reinstall secret-shuttle.",
  );
}

async function readBundledPackageJson(): Promise<RepositoryField> {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    path.resolve(path.dirname(here), "..", "..", "..", "package.json"),
    path.resolve(path.dirname(here), "..", "..", "package.json"),
  ];
  for (const c of candidates) {
    try {
      const raw = await readFile(c, "utf8");
      return JSON.parse(raw) as RepositoryField;
    } catch { /* try next */ }
  }
  throw new ShuttleError(
    "package_json_missing",
    "Could not locate the package.json bundled with secret-shuttle.",
  );
}

/**
 * Programmatic entry point used by tests + the Commander action handler.
 * Writes the skill content to the target's spec'd destination under `cwd`.
 */
export async function agentInstallTarget(
  target: AgentTarget,
  opts: { skillContent: string; cwd: string },
): Promise<void> {
  const spec = TARGETS[target];
  const dest = path.resolve(opts.cwd, spec.destPath);
  if (spec.mode === "wholesale") {
    await writeAgentFile({ targetPath: dest, content: opts.skillContent });
  } else {
    await writeAgentSnippet({
      targetPath: dest,
      content: opts.skillContent,
      beginMarker: BEGIN_MARKER,
      endMarker: END_MARKER,
    });
  }
}

/** Programmatic entry point for tests. Returns the URL string. */
export function agentPrintSkillUrl(
  pkg: RepositoryField,
  opts: { branch?: string },
): string {
  return deriveSkillUrl(pkg, opts.branch !== undefined ? { branch: opts.branch } : {});
}

export function agentCommand(): Command {
  const agent = new Command("agent")
    .description("Install the Secret Shuttle agent skill into a project (claude/codex/cursor/copilot) or print the raw skill URL.")
    .addHelpText("after", `
Examples:
  # Install the skill into a Claude Code project (writes .claude/skills/secret-shuttle/SKILL.md):
  secret-shuttle agent install claude

  # Install for Codex (appends a snippet to AGENTS.md):
  secret-shuttle agent install codex

  # Install for Cursor (writes .cursor/rules/secret-shuttle.mdc):
  secret-shuttle agent install cursor

  # Install for GitHub Copilot (appends a snippet to .github/copilot-instructions.md):
  secret-shuttle agent install copilot

  # Print the canonical raw skill URL (paste into any agent that supports a remote skill URL):
  secret-shuttle agent print-skill-url

  # Print the skill URL for a non-default branch:
  secret-shuttle agent print-skill-url --branch dev
`);

  agent
    .command("install <target>")
    .description("Write the Secret Shuttle skill into the project so the named agent can read it. Operates on the current working directory. target = claude | codex | cursor | copilot.")
    .action(async (target: string) => {
      if (target !== "claude" && target !== "codex" && target !== "cursor" && target !== "copilot") {
        throw new ShuttleError(
          "bad_request",
          `target must be one of: claude, codex, cursor, copilot. Got: ${target}`,
        );
      }
      const skillContent = await readBundledSkill();
      await agentInstallTarget(target, { skillContent, cwd: process.cwd() });
      const spec = TARGETS[target];
      process.stdout.write(`wrote ${spec.destPath} (${spec.mode})\n`);
    });

  agent
    .command("print-skill-url")
    .description("Print the raw GitHub URL of the canonical SKILL.md (paste this one line into any agent that supports a remote skill URL).")
    .option("--branch <name>", "Override the default 'main' branch.")
    .option("--ref <name>", "Alias for --branch.")
    .action(async (opts: { branch?: string; ref?: string }) => {
      const pkg = await readBundledPackageJson();
      const branch = opts.branch ?? opts.ref;
      const url = agentPrintSkillUrl(pkg, branch !== undefined ? { branch } : {});
      process.stdout.write(`${url}\n`);
    });

  return agent;
}
