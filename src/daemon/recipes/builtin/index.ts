import type { RecipeRegistry } from "../registry.js";
import { stripeCapture } from "./stripe-capture.js";
import { vercelInject } from "./vercel-inject.js";

export function registerBuiltinRecipes(registry: RecipeRegistry): void {
  registry.registerCapture(stripeCapture);
  registry.registerInject(vercelInject);
}
