import type { TemplateDefinition } from "../registry.js";

export const vercelEnvAdd: TemplateDefinition = {
  id: "vercel-env-add",
  description: "Add a Vercel environment variable via the official Vercel CLI, reading the secret from stdin.",
  binary: "vercel",
  args: ["env", "add", "{{name}}", "{{environment}}"],
  secret_delivery: "stdin",
  required_params: ["name", "environment"],
  requires_approval_when_production: true,
};
