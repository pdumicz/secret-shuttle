import type { Command } from "commander";

/**
 * Adds the repeatable `--approval-id <id>` option to a command. Used by every
 * CLI command that gates on the approval flow. Each occurrence appends to an
 * accumulator, so `--approval-id a --approval-id b` yields ["a", "b"].
 *
 * After parsing: cmd.opts().approvalId has type `string[] | undefined`. Pass
 * to the body as `approval_ids` (NOT `approval_id`) — the route's
 * optApprovalIds helper normalizes either field, but new code sends the
 * canonical array form.
 */
export function addApprovalIdOption(cmd: Command): Command {
  const accumulator = (val: string, prev: string[] | undefined): string[] =>
    prev ? [...prev, val] : [val];
  return cmd.option(
    "--approval-id <id>",
    "Pre-issued approval id. Repeatable when an operation needs multiple approvals.",
    accumulator,
  );
}
