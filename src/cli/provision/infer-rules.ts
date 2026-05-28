/**
 * Maps secret env-var names to a guessed source kind for `provision --infer`.
 *
 * Rules are evaluated in order; the first match wins. Rule matching is
 * case-insensitive. The fallback `{ kind: "unknown" }` indicates the user
 * must edit the generated yml before --continue.
 *
 * See spec §1 for the rule table and rationale.
 */

export type InferredSource =
  | { kind: "capture"; url: string }
  | { kind: "random_32_bytes" }
  | { kind: "random_64_bytes" }
  | { kind: "existing"; placeholder: boolean }
  | { kind: "unknown" };

interface Rule {
  test: (upperName: string) => boolean;
  source: InferredSource;
}

const RULES: readonly Rule[] = [
  // Order matters: webhook variant before generic stripe.
  {
    test: (n) => n.startsWith("STRIPE_") && n.includes("WEBHOOK"),
    source: { kind: "capture", url: "https://dashboard.stripe.com/webhooks" },
  },
  {
    test: (n) => n.startsWith("STRIPE_"),
    source: { kind: "capture", url: "https://dashboard.stripe.com/apikeys" },
  },
  {
    test: (n) => n.startsWith("SUPABASE_"),
    source: { kind: "capture", url: "https://supabase.com/dashboard/project/_/settings/api" },
  },
  {
    test: (n) => n === "OPENAI_API_KEY",
    source: { kind: "capture", url: "https://platform.openai.com/api-keys" },
  },
  {
    test: (n) => n === "ANTHROPIC_API_KEY",
    source: { kind: "capture", url: "https://console.anthropic.com/settings/keys" },
  },
  {
    test: (n) => n.startsWith("CLERK_"),
    source: { kind: "capture", url: "https://dashboard.clerk.com" },
  },
  {
    test: (n) => /^(DATABASE|POSTGRES|MYSQL)_URL$/.test(n),
    source: { kind: "existing", placeholder: true },
  },
  // Generic random fallback: any *_SECRET or *_TOKEN with no provider prefix.
  // Provider-prefixed names that didn't match a specific rule above fall
  // through to "unknown" (safer than auto-randoming a known-provider name).
  {
    test: (n) => /(SECRET|TOKEN)$/.test(n) && !/^(STRIPE|SUPABASE|OPENAI|ANTHROPIC|CLERK)_/.test(n),
    source: { kind: "random_32_bytes" },
  },
];

export function inferSourceForName(name: string): InferredSource {
  const upper = name.toUpperCase();
  for (const rule of RULES) {
    if (rule.test(upper)) return rule.source;
  }
  return { kind: "unknown" };
}
