import { ShuttleError } from "../../shared/errors.js";

/**
 * Substitute `{name}` placeholders in `template` from `params`. Throws
 * `recipe_url_params_missing` if any placeholder has no own-property string
 * value in `params` (missing keys, inherited properties, non-strings, and
 * empty strings all count as "missing" — see below).
 *
 * Placeholder grammar: `\{([a-zA-Z_][a-zA-Z0-9_]*)\}` — alphanumeric +
 * underscore, must start with letter or underscore. Same identifier shape as a
 * JavaScript variable, so authors can pick names without worrying about regex
 * escapes or URL-encoding edge cases.
 *
 * Validation rule: a placeholder counts as supplied only if `params` has its
 * OWN property (`Object.prototype.hasOwnProperty`) and the value's `typeof`
 * is `"string"` AND the string is non-empty. This blocks accidental matches
 * against inherited members like `toString`/`constructor`, non-string values
 * the parser shouldn't have let through but we don't trust, and empty strings
 * (which would produce a malformed URL path segment like `https://vercel.com//my-app/...`).
 *
 * Extra keys in `params` that don't appear in `template` are silently ignored
 * (forward-compat: a recipe author can add a new placeholder later without
 * breaking users who pre-supplied an unused key).
 *
 * Repeated occurrences of the same placeholder all substitute. No nesting,
 * no defaults, no escapes — keep it dumb until a real need emerges.
 */
export function interpolateUrl(template: string, params: Record<string, string>): string {
  const placeholderRe = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  const missing: string[] = [];
  const out = template.replace(placeholderRe, (_, name: string) => {
    const hasOwn = Object.prototype.hasOwnProperty.call(params, name);
    const v = hasOwn ? (params as Record<string, unknown>)[name] : undefined;
    if (!hasOwn || typeof v !== "string" || v === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(v);
  });
  if (missing.length > 0) {
    const uniq = Array.from(new Set(missing));
    throw new ShuttleError(
      "recipe_url_params_missing",
      `Recipe URL needs url_params: ${uniq.join(", ")}. Add \`url_params: { ${uniq.join(": ..., ")}: ... }\` to the destination in your yml.`,
    );
  }
  return out;
}
