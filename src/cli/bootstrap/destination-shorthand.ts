import { ShuttleError } from "../../shared/errors.js";

export interface ResolvedDestination {
  template_id: string;
  template_params: Record<string, string>;
  /** Display-only: the provider's primary domain for audit + UI. */
  domain: string;
}

function fail(shorthand: string, reason: string): never {
  throw new ShuttleError(
    "bootstrap_destination_unknown",
    `destination "${shorthand}": ${reason}`,
  );
}

export function resolveDestinationShorthand(shorthand: string, secretName: string): ResolvedDestination {
  const colon = shorthand.indexOf(":");
  if (colon < 1) {
    fail(shorthand, "expected <provider>:<scope> format");
  }
  const provider = shorthand.slice(0, colon);
  const scope = shorthand.slice(colon + 1);
  if (scope.length === 0) {
    fail(shorthand, "scope after : must not be empty");
  }

  switch (provider) {
    case "vercel": {
      if (!["production", "preview", "development"].includes(scope)) {
        fail(shorthand, `vercel scope must be one of: production, preview, development`);
      }
      return {
        template_id: "vercel-env-add",
        template_params: { name: secretName, environment: scope },
        domain: "vercel.com",
      };
    }
    case "github-actions": {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope)) {
        fail(shorthand, "github-actions scope must be owner/repo");
      }
      return {
        template_id: "github-actions-secret-set",
        template_params: { name: secretName, repo: scope },
        domain: "github.com",
      };
    }
    case "cloudflare": {
      return {
        template_id: "cloudflare-secret-put",
        template_params: { name: secretName, env: scope },
        domain: "cloudflare.com",
      };
    }
    case "supabase": {
      return {
        template_id: "supabase-edge-secret-set",
        template_params: { name: secretName, project_ref: scope },
        domain: "supabase.com",
      };
    }
    default:
      fail(shorthand, `unknown provider "${provider}" (supported: vercel, github-actions, cloudflare, supabase)`);
  }
}
