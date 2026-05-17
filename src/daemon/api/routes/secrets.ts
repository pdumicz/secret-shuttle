import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import { generateSecretValue } from "../../helpers/generate-value.js";
import { fingerprintMatches } from "../../../vault/fingerprints.js";
import { canonicalEnvironment, buildSecretRef } from "../../../shared/refs.js";
import { domainMatches, normalizeDomain } from "../../../policy/domain-policy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";

interface ListBody { environment?: string; source?: string; }
interface GenerateBody {
  name: string;
  environment: string;
  source?: string;
  kind?: string;
  allowed_domains?: string[];
  description?: string;
  force?: boolean;
  approval_id?: string;
  wait_for_approval?: boolean;
}
interface CaptureBody {
  name: string;
  environment: string;
  source: string;
  from?: "focused-field" | "selection";
  allowed_domains?: string[];
  description?: string;
  force?: boolean;
  approval_id?: string;
  wait_for_approval?: boolean;
}
interface InjectBody {
  ref: string;
  domain?: string;
  approval_id?: string;
  wait_for_approval?: boolean;
}
interface CompareBody {
  ref: string;
  with?: "focused-field" | "selection";
  domain?: string;
}

export function registerSecrets(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/secrets/list", async (_req, raw) => {
    services.lock.requireKey();
    const b = (raw ?? {}) as ListBody;
    const secrets = await services.vault.list({
      ...(b.environment !== undefined ? { environment: b.environment } : {}),
      ...(b.source !== undefined ? { source: b.source } : {}),
    });
    return { secrets, value_visible_to_agent: false };
  });

  server.addRoute("POST", "/v1/secrets/inspect", async (_req, raw) => {
    services.lock.requireKey();
    const b = raw as { ref?: string } | null;
    if (b === null || typeof b.ref !== "string") throw new ShuttleError("bad_request", "ref is required.");
    const secret = await services.vault.inspect(b.ref);
    return { secret, value_visible_to_agent: false };
  });

  server.addRoute("POST", "/v1/secrets/generate", async (_req, raw) => {
    services.lock.requireKey();
    const b = raw as GenerateBody;
    try {
      const env = canonicalEnvironment(b.environment);
      const plannedRef = buildSecretRef(b.source ?? "local", env, b.name);
      const effectiveAllowed = b.allowed_domains ?? [];

      const binding: ApprovalBinding = {
        action: "generate",
        ref: null,
        planned_ref: plannedRef,
        environment: env,
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        template_params: null,
        allowed_domains: effectiveAllowed,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      const value = generateSecretValue(b.kind ?? "random_32_bytes");
      const meta = await services.vault.upsertSecret({
        name: b.name,
        environment: env,
        source: b.source ?? "local",
        value,
        ...(b.description !== undefined ? { description: b.description } : {}),
        allowedDomains: effectiveAllowed,
        ...(b.force !== undefined ? { force: b.force } : {}),
      });
      await writeDaemonAudit({ action: "generate", ok: true, ref: meta.ref, environment: meta.environment });
      return {
        generated: true,
        secret_ref: meta.ref,
        name: meta.name,
        environment: meta.environment,
        fingerprint: meta.fingerprint,
        value_visible_to_agent: false,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "generate",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.name !== undefined && b.environment !== undefined ? { ref: buildSecretRef(b.source ?? "local", b.environment, b.name) } : {}),
      });
      throw err;
    }
  });

  server.addRoute("POST", "/v1/secrets/capture", async (_req, raw) => {
    services.lock.requireKey();
    const b = raw as CaptureBody;
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");

      const env = canonicalEnvironment(b.environment);
      const plannedRef = buildSecretRef(b.source, env, b.name);
      const pre = await services.browser.readFocusedFingerprintAndDomain();
      const effectiveAllowed = b.allowed_domains ?? [pre.domain];

      services.blind.assertForDomain(pre.domain);
      enforceDomain(pre.domain, effectiveAllowed, "capture");

      const binding: ApprovalBinding = {
        action: "capture",
        ref: null,
        planned_ref: plannedRef,
        environment: env,
        destination_domain: pre.domain,
        target_id: pre.target_id,
        field_fingerprint: pre.field_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: effectiveAllowed,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      const capture = b.from === "selection"
        ? await services.browser.captureSelection()
        : await services.browser.captureFocused();

      if (
        capture.target_id !== pre.target_id ||
        capture.domain !== pre.domain ||
        capture.field_fingerprint !== pre.field_fingerprint
      ) {
        throw new ShuttleError("field_changed", "Focused field changed after approval.");
      }

      const meta = await services.vault.upsertSecret({
        name: b.name,
        environment: env,
        source: b.source,
        value: capture.value,
        ...(b.description !== undefined ? { description: b.description } : {}),
        allowedDomains: effectiveAllowed,
        ...(b.force !== undefined ? { force: b.force } : {}),
      });
      await writeDaemonAudit({ action: "capture", ok: true, ref: meta.ref, environment: meta.environment, domain: capture.domain });
      return {
        captured: true,
        secret_ref: meta.ref,
        fingerprint: meta.fingerprint,
        captured_from: b.from ?? "focused-field",
        browser_domain: capture.domain,
        field: capture.field,
        value_visible_to_agent: false,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "capture",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
      });
      throw err;
    }
  });

  server.addRoute("POST", "/v1/secrets/inject", async (_req, raw) => {
    services.lock.requireKey();
    const b = raw as InjectBody;
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");

      const secret = await services.vault.getSecret(b.ref);
      const pre = await services.browser.readFocusedFingerprintAndDomain();
      if (b.domain !== undefined && !domainMatches(pre.domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Current domain ${pre.domain} != ${b.domain}.`);
      }
      enforceDomain(pre.domain, secret.allowed_domains, "inject");

      const binding: ApprovalBinding = {
        action: "inject",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: pre.domain,
        target_id: pre.target_id,
        field_fingerprint: pre.field_fingerprint,
        template_id: null,
        template_params: null,
        allowed_domains: secret.allowed_domains,
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      const post = await services.browser.readFocusedFingerprintAndDomain();
      if (post.target_id !== pre.target_id || post.field_fingerprint !== pre.field_fingerprint || post.domain !== pre.domain) {
        throw new ShuttleError("field_changed", "Focused field changed after approval.");
      }

      const result = await services.browser.injectFocused(secret.value);
      await services.vault.markUsed(secret.ref);
      await writeDaemonAudit({ action: "inject", ok: true, ref: secret.ref, environment: secret.environment, domain: result.domain });
      return {
        injected: true,
        secret_ref: secret.ref,
        browser_domain: result.domain,
        field: result.field,
        value_visible_to_agent: false,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "inject",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.ref !== undefined ? { ref: b.ref } : {}),
      });
      throw err;
    }
  });

  server.addRoute("POST", "/v1/secrets/compare", async (_req, raw) => {
    services.lock.requireKey();
    const b = raw as CompareBody;
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      const secret = await services.vault.getSecret(b.ref);
      const capture = b.with === "selection"
        ? await services.browser.captureSelection()
        : await services.browser.captureFocused();
      if (b.domain !== undefined && !domainMatches(capture.domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Current domain ${capture.domain} != ${b.domain}.`);
      }
      enforceDomain(capture.domain, secret.allowed_domains, "compare");
      const matches = fingerprintMatches(capture.value, secret.fingerprint);
      await writeDaemonAudit({ action: "compare", ok: true, ref: secret.ref, environment: secret.environment, domain: capture.domain });
      return {
        matches,
        secret_ref: secret.ref,
        browser_domain: capture.domain,
        compared_with: b.with ?? "focused-field",
        value_visible_to_agent: false,
      };
    } catch (err) {
      await writeDaemonAudit({
        action: "compare",
        ok: false,
        error_code: err instanceof ShuttleError ? err.code : "unexpected_error",
        ...(b.ref !== undefined ? { ref: b.ref } : {}),
      });
      throw err;
    }
  });
}

function enforceDomain(current: string, allowed: string[], action: string): void {
  if (allowed.length === 0) {
    throw new ShuttleError(
      "domain_not_allowed",
      `Refused to ${action} on ${normalizeDomain(current)}: this secret has no allowed domains. Re-create it with --allow-domain.`,
    );
  }
  if (!allowed.some((a) => domainMatches(current, a))) {
    throw new ShuttleError(
      "domain_not_allowed",
      `Refused to ${action} on ${normalizeDomain(current)}. Allowed: ${allowed.join(", ")}.`,
    );
  }
}
