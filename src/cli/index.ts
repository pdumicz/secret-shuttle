#!/usr/bin/env node
import { Command } from "commander";
import { browserCommand } from "./commands/browser.js";
import { blindCommand } from "./commands/blind.js";
import { daemonCommand } from "./commands/daemon.js";
import { captureCommand } from "./commands/capture.js";
import { compareCommand } from "./commands/compare.js";
import { generateCommand } from "./commands/generate.js";
import { initCommand } from "./commands/init.js";
import { injectCommand } from "./commands/inject.js";
import { injectSubmitCommand } from "./commands/inject-submit.js";
import { revealCaptureCommand } from "./commands/reveal-capture.js";
import { inspectCommand } from "./commands/inspect.js";
import { listCommand } from "./commands/list.js";
import { useAsStdinCommand } from "./commands/use-as-stdin.js";
import { unlockCommand } from "./commands/unlock.js";
import { templateCommand } from "./commands/template.js";
import { migrateCommand } from "./commands/migrate.js";
import { doctorCommand } from "./commands/doctor.js";
import { statusCommand } from "./commands/status.js";
import { agentCommand } from "./commands/agent.js";
import { secretsCommand } from "./commands/secrets/index.js";
import { ShuttleError, errorToJson } from "../shared/errors.js";

const program = new Command();

program
  .name("secret-shuttle")
  .description("A local blind-secret bridge for AI coding agents.")
  .version("0.1.1");

program.addCommand(initCommand());
program.addCommand(browserCommand());
program.addCommand(blindCommand());
program.addCommand(captureCommand());
program.addCommand(injectCommand());
program.addCommand(injectSubmitCommand());
program.addCommand(revealCaptureCommand());
program.addCommand(generateCommand());
program.addCommand(compareCommand());
program.addCommand(useAsStdinCommand());
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

if (process.argv.length <= 2) {
  program.help();
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorToJson(error), null, 2)}\n`);
  process.exitCode = error instanceof ShuttleError ? error.exitCode : 1;
}
