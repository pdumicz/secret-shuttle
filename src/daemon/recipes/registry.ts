import { canonicalHost } from "./host.js";
import type { CaptureRecipe, InjectRecipe } from "./types.js";

export class RecipeRegistry {
  private readonly capture = new Map<string, CaptureRecipe>();
  private readonly inject = new Map<string, InjectRecipe>();

  registerCapture(r: CaptureRecipe): void { this.capture.set(canonicalHost(r.host), r); }
  registerInject(r: InjectRecipe): void { this.inject.set(canonicalHost(r.host), r); }

  getCapture(host: string): CaptureRecipe | undefined { return this.capture.get(canonicalHost(host)); }
  getInject(host: string): InjectRecipe | undefined { return this.inject.get(canonicalHost(host)); }

  listCapture(): CaptureRecipe[] { return [...this.capture.values()]; }
  listInject(): InjectRecipe[] { return [...this.inject.values()]; }
}

// Module-singleton, builtins registered here (mirrors api/routes/templates.ts `registry`).
// Builtin recipes are added in Task 11 (Stripe capture, Vercel inject).
export const recipeRegistry = new RecipeRegistry();
// registerBuiltinRecipes(recipeRegistry);  // ← uncommented in Task 11
