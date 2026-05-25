import { Command } from "commander";
import { keychainEnableCommand } from "./enable.js";
import { keychainDisableCommand } from "./disable.js";
import { keychainStatusCommand } from "./status.js";

export function keychainCommand(): Command {
  return new Command("keychain")
    .description("Manage OS keychain enrollment for passwordless unlock (Touch ID on macOS, libsecret on Linux, DPAPI on Windows).")
    .addCommand(keychainEnableCommand())
    .addCommand(keychainDisableCommand())
    .addCommand(keychainStatusCommand());
}
