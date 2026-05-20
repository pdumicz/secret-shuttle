import { ShuttleError } from "../../../shared/errors.js";
import type { TemplateDefinition } from "../registry.js";

const ENV_ORG_REJECTION =
  "github-actions-secret-set only supports repo-scoped secrets. For environment-scoped (--env) or org-scoped (--org) secrets, use the dedicated templates (planned follow-up); do not pass env/org to this template.";

// gh secret set <name> --repo <owner/repo>   (value from stdin)
//
// Spec §9 names this template. The [P2b] gate (Task 11) verifies the argv
// shape against `gh secret set --help` at execution time. This template ships
// the minimal common case (repo secret, stdin delivery) which the [P2b] gate
// is expected to pass on every supported gh version.
//
// GitHub's per-scope argv is MUTUALLY-EXCLUSIVE: --env requires --repo,
// --org excludes --repo. A single optional-args composition is brittle and
// could produce an invalid CLI call. env / org params are therefore REJECTED
// with invalid_template_param; use separate per-scope templates (planned
// follow-up: github-actions-env-secret-set, github-actions-org-secret-set).

export const githubActionsSecretSet: TemplateDefinition = {
  id: "github-actions-secret-set",
  description:
    "Set a GitHub Actions repository secret via the official GitHub CLI (gh), reading the value from stdin.",
  binary: "gh",
  args: ["secret", "set", "{{name}}", "--repo={{repo}}"],
  secret_delivery: "stdin",
  required_params: ["name", "repo"],
  requires_approval_when_production: true,
  destinationEnvironment: (p) => p["repo"] ?? "",
  validateParams: (params) => {
    const name = (params["name"] ?? "").trim();
    const repo = (params["repo"] ?? "").trim();
    const env = (params["env"] ?? "").trim();
    const org = (params["org"] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub Actions secret name must match ^[A-Za-z_][A-Za-z0-9_]{0,254}$.",
      );
    }
    if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub repo must be owner/repo, each side matching [A-Za-z0-9._-]{1,100}.",
      );
    }
    if (env !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(env)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub environment (--env) must match [A-Za-z0-9._-]{1,100}.",
      );
    }
    if (env !== "") {
      throw new ShuttleError("invalid_template_param", ENV_ORG_REJECTION);
    }
    if (org !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(org)) {
      throw new ShuttleError(
        "invalid_template_param",
        "GitHub organization (--org) must match [A-Za-z0-9._-]{1,100}.",
      );
    }
    if (org !== "") {
      throw new ShuttleError("invalid_template_param", ENV_ORG_REJECTION);
    }
  },
};
