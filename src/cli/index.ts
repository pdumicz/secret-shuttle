#!/usr/bin/env node
import { buildProgram } from "./build-program.js";
import { ShuttleError, errorToJson } from "../shared/errors.js";
import { consumePendingDeprecationWarning } from "../shared/deprecation.js";

const program = buildProgram();

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
