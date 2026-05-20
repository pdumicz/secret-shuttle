import { ShuttleError } from "../../../shared/errors.js";
import type { TemplateDefinition } from "../registry.js";

// wrangler secret put <NAME> [--env <env>]   (value from stdin)
//
// Optional: --env <env>. When env is set, additionalArgs() splices ["--env",
// env] into the child argv so the actual write scope matches the destination
// shown to the human in the approval UI (destinationEnvironment). The [P2b]
// gate (Task 11) confirms this argv shape against `wrangler secret put --help`
// on a current wrangler release.

export const cloudflareSecretPut: TemplateDefinition = {
  id: "cloudflare-secret-put",
  description:
    "Set a Cloudflare Worker secret via the official Wrangler CLI, reading the value from stdin.",
  binary: "wrangler",
  args: ["secret", "put", "{{name}}"],
  secret_delivery: "stdin",
  required_params: ["name"],
  requires_approval_when_production: true,
  additionalArgs: (params) => {
    const env = (params["env"] ?? "").trim();
    return env !== "" ? ["--env", env] : [];
  },
  destinationEnvironment: (p) => (typeof p["env"] === "string" && p["env"] !== "" ? p["env"] : "production"),
  validateParams: (params) => {
    const name = (params["name"] ?? "").trim();
    const env = (params["env"] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Cloudflare secret name must match ^[A-Za-z_][A-Za-z0-9_]{0,254}$.",
      );
    }
    if (env !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(env)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Wrangler environment (--env) must match [A-Za-z0-9._-]{1,100}.",
      );
    }
  },
};
