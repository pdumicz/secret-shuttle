import { Command } from "commander";

/**
 * Curated, grouped one-line help. Stays under 30 lines per spec §5.8.
 * Exported as a pure function for unit testing.
 *
 * Only lists commands that actually exist today — no future-tense entries.
 * Re-audit this every time a public command is added or removed.
 */
export function renderTopLevelHelp(): string {
  return [
    "secret-shuttle — Let AI agents use secrets without seeing them.",
    "",
    "Setup & recovery:",
    "  init                        Interactive first-run setup",
    "  status                      Daemon, vault, and browser health",
    "  daemon start|stop|status    Daemon lifecycle",
    "  unlock                      Unlock the vault (passphrase via browser window)",
    "  keychain enable|disable|status   OS keychain enrollment (Touch ID / libsecret / DPAPI)",
    "  migrate secure-vault        Migrate a legacy vault to the envelope format",
    "",
    "Secrets:",
    "  secrets list                List stored refs (metadata only)",
    "  secrets get-ref <ref>       Show metadata for a ref",
    "  secrets set <name> ...      Store a new secret",
    "  secrets delete <ref>        Soft-delete a secret",
    "  secrets rotate <ref>        Rotate a secret",
    "",
    "Provider integration:",
    "  provision --infer|--yml|--secret|--continue  Make secrets exist in vault + destinations (single verb)",
    "  run --env-file=<f> -- <cmd>                  Run a command with secrets injected as env vars",
    "  inject -i <tpl> -o <out>                     Render a template with ss:// refs into a file",
    "  template list / template run <id>            Vetted CLI integrations",
    "  browser mark / reveal-capture / inject-submit   Browser-mediated flows",
    "",
    "Advanced:",
    "  internal session create / list / revoke      Pre-approved batch sessions",
    "",
    "Agent:",
    "  agent install claude|codex|cursor|copilot    Install operating manual",
    "  agent print-skill-url                        Print remote skill URL",
    "  help [command]                               This page, or per-command help",
    "",
    "For per-command help: secret-shuttle <command> --help",
    "",
  ].join("\n");
}

/**
 * Resolve a Commander command from the registered program tree by space-
 * separated path (e.g. "secrets list" → program → 'secrets' → 'list').
 * Returns null if any segment isn't a registered subcommand.
 */
function resolveCommandPath(root: Command, path: string): Command | null {
  const segments = path.split(/\s+/).filter((s) => s.length > 0);
  let cur: Command = root;
  for (const seg of segments) {
    const next = cur.commands.find((c) => c.name() === seg);
    if (next === undefined) return null;
    cur = next;
  }
  return cur === root ? null : cur;
}

export function helpCommand(): Command {
  return new Command("help")
    .description("Show curated command list (or per-command help with: help <command>).")
    .argument("[command...]", "Command name (space-separated, e.g. 'secrets list') to show detailed help for.")
    .action(function (this: Command, commandParts: string[] | undefined) {
      if (commandParts === undefined || commandParts.length === 0) {
        process.stdout.write(renderTopLevelHelp());
        return;
      }
      // 'this' is the help Command instance; its parent is the root program.
      const root = (this as unknown as { parent: Command | null }).parent;
      if (root === null) {
        process.stderr.write("help: cannot resolve root program\n");
        process.exitCode = 1;
        return;
      }
      const path = commandParts.join(" ");
      const target = resolveCommandPath(root, path);
      if (target === null) {
        process.stderr.write(`help: unknown command '${path}'\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(target.helpInformation());
    });
}
