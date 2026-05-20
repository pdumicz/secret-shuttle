import { ShuttleError } from "../../shared/errors.js";
import { vercelEnvAdd } from "./builtin/vercel-env-add.js";
import { githubActionsSecretSet } from "./builtin/github-actions-secret-set.js";
import { cloudflareSecretPut } from "./builtin/cloudflare-secret-put.js";
import { supabaseEdgeSecretSet } from "./builtin/supabase-edge-secret-set.js";

export interface TemplateDefinition {
  id: string;
  description: string;
  binary: string;
  args: string[];
  secret_delivery: "stdin" | "tmp_env_file_0600";
  required_params: string[];
  requires_approval_when_production: boolean;
  validateParams?: (params: Readonly<Record<string, string>>) => void;
  destinationEnvironment?: (params: Readonly<Record<string, string>>) => string;
  /**
   * Only consumed when secret_delivery === "tmp_env_file_0600". Names the argv
   * slot for the daemon-written 0600 env-file path. The string is param-expanded
   * the same way args[] is, plus the synthetic placeholder {{__env_file_path__}}
   * which the daemon substitutes at run time. Required when secret_delivery is
   * "tmp_env_file_0600"; ignored otherwise.
   */
  value_arg_template?: string | null;
  /**
   * Optional callback that returns ADDITIONAL argv flags derived from params
   * (e.g. `["--env", env]` if `env` is set). Called after the static args[]
   * are expanded and BEFORE the tmp_env_file_0600 value-arg is appended. The
   * returned array is spliced into the child argv verbatim. Used by
   * templates with optional scope params (env / project_ref) so the
   * destinationEnvironment shown to the human in the approval UI cannot
   * diverge from what the child process actually writes to.
   */
  additionalArgs?: (params: Readonly<Record<string, string>>) => string[];
}

export class TemplateRegistry {
  private readonly map: Map<string, TemplateDefinition>;
  constructor() {
    this.map = new Map<string, TemplateDefinition>([
      [vercelEnvAdd.id, vercelEnvAdd],
      [githubActionsSecretSet.id, githubActionsSecretSet],
      [cloudflareSecretPut.id, cloudflareSecretPut],
      [supabaseEdgeSecretSet.id, supabaseEdgeSecretSet],
    ]);
  }
  list(): TemplateDefinition[] {
    return [...this.map.values()];
  }
  get(id: string): TemplateDefinition {
    const t = this.map.get(id);
    if (t === undefined) throw new ShuttleError("template_not_found", `Unknown template: ${id}`);
    return t;
  }
}
