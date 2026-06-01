export type RecipeStep =
  // A pre-step click is *navigation only*. It MUST resolve to exactly one element
  // (same single-match rule as resolveSelectorToHandle) and SHOULD target a stable
  // nav affordance (data-*/aria-*/role on a link/tab), never a submit/delete/reveal
  // /destructive/scope-switch control. See §1 pre_steps safety contract.
  | { action: "click"; selector: string }
  | { action: "wait_for"; selector: string; timeout_ms?: number }
  | { action: "wait"; ms: number };

export interface RecipeBase {
  host: string;                 // canonical host (lowercase, trailing-dot stripped) — matched against expectedHost
  url: string;                  // page to open (static in increment 1; param interpolation deferred, §9)
  logged_in_probe: string;      // present iff authenticated AND on the expected page/scope (scope-specific)
  page_ready_probe?: string;    // present on any successful load; absent after timeout => recipe_page_timeout (§4)
  logged_out_marker?: string;   // present ONLY on the provider login/auth screen => bootstrap_login_required (§4)
  ready_timeout_ms?: number;    // bound for page_ready_probe wait
  pre_steps?: RecipeStep[];     // non-secret, non-destructive navigation (see §1 contract)
  verified_against_real_page?: string; // ISO date a human dogfooded it; surfaced in the README matrix
}

export interface CaptureRecipe extends RecipeBase {
  kind: "capture";
  reveal_selector: string;      // the "reveal"/"show" control
  field_selector?: string;      // EITHER: input/textarea holding the secret (field mode)
  container_selector?: string;  // OR: subtree whose revealed text is the secret (container mode)
  hide_selector?: string;       // optional control to restore the hidden state
}

export interface InjectRecipe extends RecipeBase {
  kind: "inject";
  field_selector: string;       // where the value goes
  submit_selector: string;      // the submit/save control
  success_text: string;         // text observed on a successful save
}

export type Recipe = CaptureRecipe | InjectRecipe;
