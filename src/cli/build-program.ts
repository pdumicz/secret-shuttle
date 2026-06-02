import { Command } from "commander";
import { browserCommand } from "./commands/browser.js";
import { daemonCommand } from "./commands/daemon.js";
import { initCommand } from "./commands/init.js";
import { injectSubmitCommand } from "./commands/inject-submit.js";
import { revealCaptureCommand } from "./commands/reveal-capture.js";
import { unlockCommand } from "./commands/unlock.js";
import { templateCommand } from "./commands/template.js";
import { migrateCommand } from "./commands/migrate.js";
import { statusCommand } from "./commands/status.js";
import { agentCommand } from "./commands/agent.js";
import { secretsCommand } from "./commands/secrets/index.js";
import { keychainCommand } from "./commands/keychain/index.js";
import { runCommand } from "./commands/run.js";
import { injectCommand } from "./commands/inject.js";
import { importCommand } from "./commands/import.js";
import { provisionCommand } from "./commands/provision.js";
import { internalCommand } from "./commands/internal.js";
import { helpCommand } from "./commands/help.js";
import { auditCommand } from "./commands/audit.js";
import { ShuttleError } from "../shared/errors.js";

/**
 * Build the fully-configured `secret-shuttle` Commander tree WITHOUT parsing
 * argv, printing help, or exiting. Single source of truth for the registered
 * command set: consumed by the CLI entrypoint (src/cli/index.ts) and by the
 * docs/demo drift-guard (src/e2e/docs-no-removed-verbs.test.ts). Calling it has
 * no side effects beyond allocating Command objects, so it is safe to import
 * from tests.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("secret-shuttle")
    .description(
      "Local-daemon CLI for AI coding agents.\nAGENT QUICKSTART: read skills/secret-shuttle/SKILL.md or run `secret-shuttle help`.",
    )
    .version("0.5.0");

  program.addCommand(initCommand());
  program.addCommand(browserCommand());
  program.addCommand(injectSubmitCommand());
  program.addCommand(revealCaptureCommand());
  program.addCommand(unlockCommand());
  program.addCommand(templateCommand());
  program.addCommand(daemonCommand());
  program.addCommand(migrateCommand());
  program.addCommand(statusCommand());
  program.addCommand(agentCommand());
  program.addCommand(secretsCommand());
  program.addCommand(keychainCommand());
  program.addCommand(importCommand());
  program.addCommand(provisionCommand());

  // Stub `bootstrap` so running it surfaces command_renamed via the top-level
  // catch in src/cli/index.ts (writes JSON to stderr, sets exitCode).
  // DO NOT outputJson + process.exit here — that bypasses the top-level
  // deprecation-warning handling and writes to stdout instead of stderr.
  const bootstrapStub = new Command("bootstrap")
    .description("Renamed to `provision` in v0.3.0.")
    .allowUnknownOption()
    .action(() => {
      throw new ShuttleError(
        "command_renamed",
        "The `bootstrap` verb was renamed to `provision` in v0.3.0. Re-run with `secret-shuttle provision <same flags>`.",
      );
    });
  program.addCommand(bootstrapStub);

  program.addCommand(runCommand());
  program.addCommand(injectCommand());
  program.addCommand(auditCommand());
  program.addCommand(internalCommand(), { hidden: true });
  program.addCommand(helpCommand());

  return program;
}
