import { ShuttleError } from "../shared/errors.js";
import type { SecretAction, SecretRecord } from "../vault/types.js";

export function assertSecretActionAllowed(secret: SecretRecord, action: SecretAction): void {
  if (!secret.allowed_actions.includes(action)) {
    throw new ShuttleError(
      "action_not_allowed",
      `Secret ${secret.ref} is not allowed to perform action ${action}.`,
    );
  }
}
