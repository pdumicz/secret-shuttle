import { ShuttleError } from "../shared/errors.js";
import type { SecretAction, SecretRecord } from "../vault/types.js";

// Burst 7 §2 (5q): widened to the structural subset actually read (ref +
// allowed_actions) so it type-checks against SecretRecord, AgentSecretMetadata,
// AND ResolvedSecret without forcing any caller to carry the stored string.
export function assertSecretActionAllowed(
  secret: Pick<SecretRecord, "ref" | "allowed_actions">,
  action: SecretAction,
): void {
  if (!secret.allowed_actions.includes(action)) {
    throw new ShuttleError(
      "action_not_allowed",
      `Secret ${secret.ref} is not allowed to perform action ${action}.`,
    );
  }
}
