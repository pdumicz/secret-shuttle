import { ShuttleError } from "../../../shared/errors.js";
import type { TemplateDefinition } from "../registry.js";

export const vercelEnvAdd: TemplateDefinition = {
  id: "vercel-env-add",
  description: "Add a Vercel environment variable via the official Vercel CLI, reading the secret from stdin.",
  binary: "vercel",
  args: ["env", "add", "{{name}}", "{{environment}}"],
  secret_delivery: "stdin",
  required_params: ["name", "environment"],
  requires_approval_when_production: true,
  destinationEnvironment: (p) => (p["environment"] === "production" ? "production" : (p["environment"] ?? "development")),
  validateParams: (params) => {
    const name = params["name"] ?? "";
    const environment = params["environment"] ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Vercel env var name must match ^[A-Za-z_][A-Za-z0-9_]{0,127}$.",
      );
    }
    if (!["production", "preview", "development"].includes(environment)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Vercel environment must be one of: production, preview, development.",
      );
    }
  },
};
