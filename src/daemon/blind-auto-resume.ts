import { ShuttleError } from "../shared/errors.js";
import { writeDaemonAudit } from "./audit.js";
import type { DaemonServices } from "./services.js";

export interface AutoResumeArgs {
  op: "inject_submit" | "reveal_capture";
  domain: string;
  success_signal: "text_matched" | "secret_captured";
  absence_proof: "passed";
}

/**
 * Spec §7. NOT a call to /v1/blind/end and must never weaken it.
 * Asserts the success+proof preconditions, then ends blind directly — WITHOUT a
 * human approval and WITHOUT blankAllPages (the absence proof already established
 * the secret is gone; the page is the proven-clean post-transaction state). Writes
 * its OWN audit record under the distinct `blind_auto_resume` action. Never
 * carries the secret or observed text.
 */
export async function autoResumeBlind(services: DaemonServices, args: AutoResumeArgs): Promise<void> {
  if (
    (args.success_signal !== "text_matched" && args.success_signal !== "secret_captured") ||
    args.absence_proof !== "passed"
  ) {
    throw new ShuttleError(
      "auto_resume_precondition",
      "autoResumeBlind requires success_signal=text_matched AND absence_proof=passed.",
    );
  }
  services.blind.end();
  await writeDaemonAudit({
    action: "blind_auto_resume",
    ok: true,
    domain: args.domain,
    op: args.op,
    success_signal: args.success_signal,
    absence_proof: args.absence_proof,
  });
}
