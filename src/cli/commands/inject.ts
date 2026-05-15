import { Command } from "commander";
import { PlaywrightFocusedFieldAdapter } from "../../browser/playwright-adapter.js";
import { writeAuditEvent } from "../../logging/logger.js";
import { requireApproval } from "../../policy/approvals.js";
import { assertDomainAllowed, assertProvidedDomainMatchesCurrent } from "../../policy/domain-policy.js";
import { assertSecretActionAllowed } from "../../policy/policy.js";
import { ok, outputJson } from "../../shared/result.js";
import { Vault } from "../../vault/vault.js";
import { assertFocusedTarget, normalizeRef } from "./helpers.js";

export function injectCommand(): Command {
  return new Command("inject")
    .description("Inject a stored secret into the focused browser field without printing it.")
    .requiredOption("--ref <ref>", "Secret Shuttle ref.")
    .option("--to <target>", "Injection target.", "focused-field")
    .option("--domain <domain>", "Expected current browser domain.")
    .option("--cdp-url <url>", "Chrome DevTools Protocol URL.", process.env.SECRET_SHUTTLE_CDP_URL)
    .option("--confirm-production <word>", "Non-interactive production approval. Must be PRODUCTION.")
    .action(async (options) => {
      assertFocusedTarget(options.to);
      const ref = normalizeRef(options.ref);
      const vault = new Vault();
      const secret = await vault.getSecret(ref);
      assertSecretActionAllowed(secret, "inject_into_field");

      const adapter = new PlaywrightFocusedFieldAdapter({ cdpUrl: options.cdpUrl });
      const currentDomain = await adapter.currentDomain();
      assertProvidedDomainMatchesCurrent(options.domain, currentDomain);
      assertDomainAllowed(currentDomain, secret.allowed_domains, "inject");

      await requireApproval({
        secret,
        action: "inject",
        destination: currentDomain,
        confirmProduction: options.confirmProduction,
      });

      const result = await adapter.write(secret.value);
      await vault.markUsed(secret.ref);
      await writeAuditEvent({
        action: "inject",
        ok: true,
        ref: secret.ref,
        domain: result.domain,
        environment: secret.environment,
      });

      outputJson(ok({
        injected: true,
        secret_ref: secret.ref,
        browser_domain: result.domain,
        field: result.field,
        value_visible_to_agent: false,
      }));
    });
}
