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
  /**
   * Burst 5 §2: keys of `template_params` whose values determine WHERE
   * the secret is pushed. Provision-derived sessions stamp these onto
   * SessionPattern.required_params so the matcher cannot widen consent
   * to a different destination. `name` is universally destination-
   * defining (the env-var / secret name set at the provider).
   *
   * Templates without this field are excluded from provision-derived
   * sessions (fail-closed) and produce a startup-time warning. See
   * src/daemon/templates/destination-defining-params.ts.
   */
  sessionDefiningParams?: readonly string[];
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
  /**
   * Register (or replace) a template definition.  Exposed for tests that need
   * to drive /v1/templates/run with a stub binary (e.g. process.execPath) so
   * the success and post-mint-failure audit paths can be exercised without
   * relying on the host having vercel / gh / wrangler / supabase installed.
   * Not used by production code paths.
   */
  register(spec: TemplateDefinition): void {
    this.map.set(spec.id, spec);
  }
  /** Test-only: drop a template by id.  Used by tests that register a stub
   * template and want to leave the process-shared registry pristine for
   * subsequent tests. */
  unregister(id: string): void {
    this.map.delete(id);
  }
}

/**
 * Reject any param whose value has leading or trailing whitespace. Padded
 * values create a divergence between validateParams / additionalArgs (which
 * trim internally) and destinationEnvironment (which uses the raw value),
 * enabling a production-approval bypass: e.g. env=" production " would
 * execute `wrangler ... --env production` (a production write) while
 * destinationEnvironment returns " production " (≠ "production"), bypassing
 * the route's production-approval elevation. Whitespace-only values
 * (e.g. "   ") similarly diverge: argv is empty (default scope) while
 * destinationEnvironment returns "   " (a non-empty non-"production" string).
 *
 * Called from BOTH the templates route (before destinationEnvironment is
 * called for the approval binding) AND runTemplate (defense in depth, in
 * case runTemplate is invoked outside the route).
 *
 * Throws ShuttleError("invalid_template_param", ...) on the first padded
 * param found.
 */
export function assertNoPaddedParams(params: Readonly<Record<string, string>>): void {
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v !== v.trim()) {
      throw new ShuttleError(
        "invalid_template_param",
        `Parameter ${k} must not contain leading or trailing whitespace; padding creates a divergence between argv and destinationEnvironment that can bypass production-approval elevation.`,
      );
    }
  }
}
