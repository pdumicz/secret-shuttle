import readline from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import { ShuttleError } from "../shared/errors.js";
import type { SecretRecord } from "../vault/types.js";

export interface ApprovalRequest {
  secret: Pick<SecretRecord, "ref" | "environment" | "requires_approval">;
  action: "capture" | "inject" | "compare" | "use-as-stdin";
  destination: string;
  confirmProduction?: string;
}

export async function requireApproval(request: ApprovalRequest): Promise<void> {
  if (!request.secret.requires_approval && request.secret.environment !== "production") {
    return;
  }

  if (request.secret.environment !== "production") {
    return;
  }

  if (request.confirmProduction === "PRODUCTION") {
    return;
  }

  if (!input.isTTY) {
    throw new ShuttleError(
      "production_approval_required",
      "Production action requires approval. Run interactively and type PRODUCTION, or pass --confirm-production PRODUCTION.",
    );
  }

  output.write("\nSecret Shuttle wants to use a production secret.\n\n");
  output.write(`Secret: ${request.secret.ref}\n`);
  output.write(`Destination: ${request.destination}\n`);
  output.write(`Environment: ${request.secret.environment}\n`);
  output.write(`Action: ${request.action}\n`);
  output.write("Raw value will not be shown to the agent.\n\n");

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question("Type PRODUCTION to continue: ");
  rl.close();

  if (answer !== "PRODUCTION") {
    throw new ShuttleError("approval_denied", "Production approval was not granted.");
  }
}
