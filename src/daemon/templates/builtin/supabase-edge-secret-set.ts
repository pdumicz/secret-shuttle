import { ShuttleError } from "../../../shared/errors.js";
import type { TemplateDefinition } from "../registry.js";

// supabase secrets set --env-file <path>   (value via 0600 daemon-owned env-file)
//
// Spec §9: /dev/stdin is NOT portable (no /dev/stdin on Windows; fragile on
// some shells), so the safe default for supabase is tmp_env_file_0600. The
// [P2b] gate (Task 11) confirms this argv shape against
// `supabase secrets set --help` on a current supabase release.
//
// Optional --project-ref <ref>. project_ref carried into destinationEnvironment
// so the approval UI shows the destination project; the shipped args[] omits
// the --project-ref flag (a future template variant can add it once [P2b]
// confirms the per-variant argv vector on the current supabase release).

export const supabaseEdgeSecretSet: TemplateDefinition = {
  id: "supabase-edge-secret-set",
  description:
    "Set a Supabase Edge Function secret via the official Supabase CLI, delivering the value through a daemon-owned 0600 env-file (no /dev/stdin).",
  binary: "supabase",
  args: ["secrets", "set"],
  secret_delivery: "tmp_env_file_0600",
  required_params: ["name"],
  requires_approval_when_production: true,
  value_arg_template: "--env-file={{__env_file_path__}}",
  destinationEnvironment: (p) =>
    typeof p["project_ref"] === "string" && p["project_ref"] !== "" ? p["project_ref"] : "production",
  validateParams: (params) => {
    const name = (params["name"] ?? "").trim();
    const projectRef = (params["project_ref"] ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Supabase secret name must match ^[A-Za-z_][A-Za-z0-9_]{0,254}$.",
      );
    }
    if (projectRef !== "" && !/^[A-Za-z0-9._-]{1,100}$/.test(projectRef)) {
      throw new ShuttleError(
        "invalid_template_param",
        "Supabase project_ref must match [A-Za-z0-9._-]{1,100}.",
      );
    }
  },
};
