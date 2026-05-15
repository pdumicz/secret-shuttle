import { Command } from "commander";
import { writeAuditEvent } from "../../logging/logger.js";
import { assertBlindModeForDomain } from "../../policy/blind-mode.js";
import { assertDomainAllowed } from "../../policy/domain-policy.js";
import { PlaywrightFocusedFieldAdapter } from "../../browser/playwright-adapter.js";
import { ok, outputJson } from "../../shared/result.js";
import { Vault } from "../../vault/vault.js";
import { assertCaptureSource, collectRepeated } from "./helpers.js";

export function captureCommand(): Command {
  return new Command("capture")
    .description("Capture a secret from selected text or the focused browser field without printing it.")
    .requiredOption("--name <name>", "Secret name, for example STRIPE_WEBHOOK_SECRET.")
    .requiredOption("--env <environment>", "Environment, for example production.")
    .requiredOption("--source <source>", "Secret source namespace, for example stripe.")
    .option("--from <source>", "Capture source: focused-field or selection.", "focused-field")
    .option("--allow-domain <domain>", "Allowed domain. Can be repeated.", collectRepeated, [])
    .option("--description <description>", "Non-secret description.")
    .option("--cdp-url <url>", "Chrome DevTools Protocol URL.", process.env.SECRET_SHUTTLE_CDP_URL)
    .option("--force", "Overwrite an existing secret with the same ref.", false)
    .action(async (options) => {
      assertCaptureSource(options.from);
      const adapter = new PlaywrightFocusedFieldAdapter({ cdpUrl: options.cdpUrl });
      const capture = await adapter.read(options.from);
      await assertBlindModeForDomain(capture.domain);

      const allowedDomains = options.allowDomain.length > 0 ? options.allowDomain : [capture.domain];
      assertDomainAllowed(capture.domain, allowedDomains, "capture");

      const vault = new Vault();
      const metadata = await vault.upsertSecret({
        name: options.name,
        environment: options.env,
        source: options.source,
        value: capture.value,
        description: options.description,
        allowedDomains,
        force: options.force,
      });

      await writeAuditEvent({
        action: "capture",
        ok: true,
        ref: metadata.ref,
        domain: capture.domain,
        environment: metadata.environment,
      });

      outputJson(ok({
        captured: true,
        secret_ref: metadata.ref,
        name: metadata.name,
        environment: metadata.environment,
        source: metadata.source,
        fingerprint: metadata.fingerprint,
        captured_from: capture.source,
        browser_domain: capture.domain,
        field: capture.field,
        value_visible_to_agent: false,
      }));
    });
}
