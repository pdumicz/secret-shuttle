#!/usr/bin/env node
import { Command } from "commander";
import { browserCommand } from "./commands/browser.js";
import { daemonCommand } from "./commands/daemon.js";
import { generateCommand } from "./commands/generate.js";
import { initCommand } from "./commands/init.js";
import { injectSubmitCommand } from "./commands/inject-submit.js";
import { revealCaptureCommand } from "./commands/reveal-capture.js";
import { inspectCommand } from "./commands/inspect.js";
import { listCommand } from "./commands/list.js";
import { unlockCommand } from "./commands/unlock.js";
import { templateCommand } from "./commands/template.js";
import { migrateCommand } from "./commands/migrate.js";
import { doctorCommand } from "./commands/doctor.js";
import { statusCommand } from "./commands/status.js";
import { agentCommand } from "./commands/agent.js";
import { secretsCommand } from "./commands/secrets/index.js";
import { runCommand } from "./commands/run.js";
import { injectCommand } from "./commands/inject.js";
import { importCommand } from "./commands/import.js";
import { internalCommand } from "./commands/internal.js";
import { helpCommand } from "./commands/help.js";
import { ShuttleError, errorToJson } from "../shared/errors.js";
import { consumePendingDeprecationWarning } from "../shared/deprecation.js";

const program = new Command();

program
  .name("secret-shuttle")
  .description("A local blind-secret bridge for AI coding agents.")
  .version("0.1.1");

program.addCommand(initCommand());
program.addCommand(browserCommand());
program.addCommand(injectSubmitCommand());
program.addCommand(revealCaptureCommand());
program.addCommand(generateCommand());
program.addCommand(listCommand());
program.addCommand(inspectCommand());
program.addCommand(unlockCommand());
program.addCommand(templateCommand());
program.addCommand(daemonCommand());
program.addCommand(migrateCommand());
program.addCommand(doctorCommand());
program.addCommand(statusCommand());
program.addCommand(agentCommand());
program.addCommand(secretsCommand());
program.addCommand(importCommand());
program.addCommand(runCommand());
program.addCommand(injectCommand());
program.addCommand(internalCommand(), { hidden: true });
program.addCommand(helpCommand());

if (process.argv.length <= 2) {
  program.help();
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const errJson = errorToJson(error) as Record<string, unknown>;
  const warning = consumePendingDeprecationWarning();
  if (warning !== null) {
    errJson.warning = warning;
  }
  process.stderr.write(`${JSON.stringify(errJson, null, 2)}\n`);
  process.exitCode = error instanceof ShuttleError ? error.exitCode : 1;
}
