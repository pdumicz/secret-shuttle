import { ShuttleError } from "../../shared/errors.js";
import type { BootstrapStore } from "./store.js";

/**
 * Passed to inner route core functions when called from the bootstrap executor.
 * The executor holds a consumed bootstrap approval; rather than minting an
 * inner approval per step (and triggering inner Touch ID / passphrase / hub
 * prompts), inner routes accept this context as proof of authority and skip
 * their own requireApprovals call.
 *
 * Validity: the batchId must exist in the BootstrapStore AND its status must
 * be "in_progress" (Phase 2 actively executing). Any other state rejects.
 *
 * SECURITY: This authority is a server-internal capability constructed by the
 * bootstrap executor. It is NEVER accepted from the HTTP request body — HTTP
 * shells construct opts WITHOUT propagating any `bootstrap_authority` field.
 */
export interface BootstrapAuthority {
  batchId: string;
}

export async function assertBootstrapAuthorityValid(
  authority: BootstrapAuthority,
  store: BootstrapStore,
): Promise<void> {
  const state = await store.get(authority.batchId);
  if (state === null) {
    throw new ShuttleError(
      "bootstrap_batch_not_found",
      `bootstrap authority batchId not found: ${authority.batchId}`,
    );
  }
  if (state.status !== "in_progress") {
    throw new ShuttleError(
      "bootstrap_batch_not_found",
      `bootstrap authority batchId ${authority.batchId} is not in_progress (status: ${state.status})`,
    );
  }
}
