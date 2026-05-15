import { Command } from "commander";
import { ShuttleError } from "../../shared/errors.js";

export function useAsStdinCommand(): Command {
  return new Command("use-as-stdin")
    .description("[Removed in Secure Mode] Use `secret-shuttle template run` instead.")
    .option("--ref <ref>")
    .option("--command <command>")
    .action(() => {
      throw new ShuttleError(
        "removed_in_secure_mode",
        "Secret Shuttle no longer supports arbitrary --command stdin in Secure Mode. Use `secret-shuttle template run` (e.g., template id `vercel-env-add`).",
      );
    });
}
