#!/usr/bin/env node
import { Command } from "commander";
import { browserCommand } from "./commands/browser.js";
import { blindCommand } from "./commands/blind.js";
import { captureCommand } from "./commands/capture.js";
import { compareCommand } from "./commands/compare.js";
import { generateCommand } from "./commands/generate.js";
import { initCommand } from "./commands/init.js";
import { injectCommand } from "./commands/inject.js";
import { inspectCommand } from "./commands/inspect.js";
import { listCommand } from "./commands/list.js";
import { useAsStdinCommand } from "./commands/use-as-stdin.js";
import { ShuttleError, errorToJson } from "../shared/errors.js";

const program = new Command();

program
  .name("secret-shuttle")
  .description("A local blind-secret bridge for AI coding agents.")
  .version("0.1.0");

program.addCommand(initCommand());
program.addCommand(browserCommand());
program.addCommand(blindCommand());
program.addCommand(captureCommand());
program.addCommand(injectCommand());
program.addCommand(generateCommand());
program.addCommand(compareCommand());
program.addCommand(useAsStdinCommand());
program.addCommand(listCommand());
program.addCommand(inspectCommand());

if (process.argv.length <= 2) {
  program.help();
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorToJson(error), null, 2)}\n`);
  process.exitCode = error instanceof ShuttleError ? error.exitCode : 1;
}
