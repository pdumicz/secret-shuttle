import { Command } from "commander";
import { PlaywrightFocusedFieldAdapter } from "../../browser/playwright-adapter.js";
import { writeAuditEvent } from "../../logging/logger.js";
import { assertDomainAllowed, assertProvidedDomainMatchesCurrent } from "../../policy/domain-policy.js";
import { assertSecretActionAllowed } from "../../policy/policy.js";
import { ok, outputJson } from "../../shared/result.js";
import { fingerprintMatches } from "../../vault/fingerprints.js";
import { loadOrCreateMasterKey } from "../../vault/keychain.js";
import { Vault } from "../../vault/vault.js";
import { assertCaptureSource, normalizeRef } from "./helpers.js";

export function compareCommand(): Command {
  return new Command("compare")
    .description("Compare selected text or the focused field against a stored secret without printing either value.")
    .requiredOption("--ref <ref>", "Secret Shuttle ref.")
    .option("--with <source>", "Comparison source: focused-field or selection.", "focused-field")
    .option("--domain <domain>", "Expected current browser domain.")
    .option("--cdp-url <url>", "Chrome DevTools Protocol URL.", process.env.SECRET_SHUTTLE_CDP_URL)
    .action(async (options) => {
      assertCaptureSource(options.with);
      const ref = normalizeRef(options.ref);
      const key = await loadOrCreateMasterKey();
      const vault = new Vault(() => key);
      const secret = await vault.getSecret(ref);
      assertSecretActionAllowed(secret, "compare_fingerprint");

      const adapter = new PlaywrightFocusedFieldAdapter({ cdpUrl: options.cdpUrl });
      const capture = await adapter.read(options.with);
      assertProvidedDomainMatchesCurrent(options.domain, capture.domain);
      assertDomainAllowed(capture.domain, secret.allowed_domains, "compare");

      const matches = fingerprintMatches(capture.value, secret.fingerprint);
      await writeAuditEvent({
        action: "compare",
        ok: true,
        ref: secret.ref,
        domain: capture.domain,
        environment: secret.environment,
      });

      outputJson(ok({
        matches,
        secret_ref: secret.ref,
        browser_domain: capture.domain,
        compared_with: capture.source,
        value_visible_to_agent: false,
      }));
    });
}
