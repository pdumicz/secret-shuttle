import { Command } from "commander";
import { compareCommand } from "./compare.js";
import { blindCommand } from "./blind.js";
import { captureCommand } from "./capture.js";
import { injectCommand } from "./inject-internal.js";
import { internalSessionCommand } from "./internal-session.js";

/**
 * The `internal` namespace holds power-user and V0/legacy commands that
 * most agents should not need:
 *   - session:  pre-approved session management (modern surface, Plan 4a)
 *   - compare:  power-user verification
 *   - blind:    low-level CDP blind-mode control
 *   - capture:  V0 path, replaced by `reveal-capture`
 *   - inject:   V0 path, replaced by `inject-submit`
 *
 * `daemon`, `unlock`, and `migrate` deliberately stay at the top level —
 * Plan 1's registry hints and Task B1's `status.next_action` emit them as
 * bare top-level recovery commands.
 */
export function internalCommand(): Command {
  const cmd = new Command("internal")
    .description("Power-user and deprecated commands. Most agents should not need these.")
    // Suppress Commander's auto-generated `help [command]` subcommand so
    // `internal --help` lists exactly the real subcommands. The standard
    // `--help` flag still works.
    .helpCommand(false);

  cmd.addCommand(internalSessionCommand());
  cmd.addCommand(compareCommand());
  cmd.addCommand(blindCommand());
  cmd.addCommand(captureCommand());
  cmd.addCommand(injectCommand());

  return cmd;
}
