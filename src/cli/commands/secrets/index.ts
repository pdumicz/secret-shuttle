import { Command } from "commander";
import { secretsListCommand } from "./list.js";
import { secretsGetRefCommand } from "./get-ref.js";
import { secretsSetCommand } from "./set.js";
import { secretsDeleteCommand } from "./delete.js";
import { secretsRotateCommand } from "./rotate.js";

export function secretsCommand(): Command {
  const cmd = new Command("secrets")
    .description("Manage vault secrets (list, get-ref, set, delete, rotate). Raw values never returned.");

  cmd.addCommand(secretsListCommand());
  cmd.addCommand(secretsGetRefCommand());
  cmd.addCommand(secretsSetCommand());
  cmd.addCommand(secretsDeleteCommand());
  cmd.addCommand(secretsRotateCommand());

  return cmd;
}
