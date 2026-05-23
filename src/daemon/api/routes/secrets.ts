import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import { generateSecretValue } from "../../helpers/generate-value.js";
import { fingerprintMatches } from "../../../vault/fingerprints.js";
import { canonicalEnvironment, buildSecretRef } from "../../../shared/refs.js";
import { domainMatches, normalizeDomain } from "../../../policy/domain-policy.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { writeDaemonAudit } from "../../audit.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { DEFAULT_ACTIONS } from "../../../vault/vault.js";
import { ALL_SECRET_ACTIONS, type SecretAction } from "../../../vault/types.js";
import { asObject, reqString } from "../validate.js";
import { disableObservationDomains } from "../../chrome/internal-ops.js";
import type { InjectResult } from "../../chrome/internal-ops.js";

interface ListBody { environment?: string; source?: string; include_deleted?: boolean; }
interface GenerateBody {
  name: string;
  environment: string;
  source?: string;
  kind?: string;
  allowed_domains?: string[];
  allowed_actions?: string[];
  description?: string;
  force?: boolean;
  approval_id?: string;
  wait_for_approval?: boolean;
  session_id?: string;
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
  approval_id?: string;
  wait_for_approval?: boolean;
}

const SECRET_ACTIONS = new Set<string>(ALL_SECRET_ACTIONS);

function validatedActions(raw: unknown): SecretAction[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !SECRET_ACTIONS.has(x))) {
    throw new ShuttleError("bad_request", "allowed_actions: must be an array of known secret actions");
  }
  return raw as SecretAction[];
}

export function registerSecrets(server: DaemonServer, services: DaemonServices, daemonPortRef: () => number): void {
  server.addRoute("POST", "/v1/secrets/list", async (_req, raw) => {
    services.lock.requireKey();
    const b = (raw ?? {}) as ListBody;
    const secrets = await services.vault.list({
      ...(b.environment !== undefined ? { environment: b.environment } : {}),
      ...(b.source !== undefined ? { source: b.source } : {}),
      ...(b.include_deleted === true ? { includeDeleted: true } : {}),
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
    // Hoisted OUTSIDE the try so a post-mint failure (e.g. vault.upsertSecret
    // throws secret_exists AFTER requireApproval consumed the session) still
    // carries grant.session_id into the failure audit.  Optional-chained at
    // use site because grant remains undefined if requireApproval itself threw
    // (pre-mint failure), in which case no session was consumed and audit
    // MUST NOT carry session_id.
    let grant: ApprovalGrant | undefined;
    try {
      const env = canonicalEnvironment(b.environment);
      const plannedRef = buildSecretRef(b.source ?? "local", env, b.name);
      const effectiveAllowed = (b.allowed_domains ?? []).map(normalizeDomain);

      // Validate BEFORE building the binding / requireApproval (§4.4): a bad
      // action set must fail fast, never after a human has approved.
      const requestedActions = validatedActions(b.allowed_actions);
      // Effective scope shown in the approval == what will actually be stored
      // (mirrors vault.upsertSecret's own resolution, §4.4): explicit wins; else
      // preserve an existing record's actions on overwrite; else the default set.
      let existingActions: SecretAction[] | undefined;
      try {
        existingActions = [...(await services.vault.getSecret(plannedRef)).allowed_actions];
      } catch {
        existingActions = undefined;
      }
      const effectiveActions = requestedActions ?? existingActions ?? [...DEFAULT_ACTIONS];

      if (canonicalEnvironment(env) === "production" && effectiveAllowed.length === 0) {
        throw new ShuttleError("missing_allow_domain", "Production secrets require at least one allowed domain.");
      }

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
        allowed_actions: effectiveActions,
      };
      // Single requireApproval call — handles both the initial (no approval_id)
      // and the retry (approval_id supplied) paths.  When session_id is set and
      // the binding matches the session pattern, the call mints a used grant
      // from the session and the audit emitted below will carry
      // grant.session_id; otherwise the call falls back to the single-use flow
      // and grant.session_id is undefined.
      grant = await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        sessionStore: services.sessionStore,
        ...(b.session_id !== undefined ? { sessionId: b.session_id } : {}),
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
        allowedActions: effectiveActions,
        ...(b.force !== undefined ? { force: b.force } : {}),
      });
      await writeDaemonAudit({
        action: "generate",
        ok: true,
        ref: meta.ref,
        environment: meta.environment,
        ...(grant.session_id !== undefined ? { session_id: grant.session_id } : {}),
      });
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
        // Optional-chain: grant is undefined if requireApproval itself threw
        // (pre-mint failure — no session consumed → audit MUST NOT carry
        // session_id).  Otherwise grant.session_id is the source session iff
        // the binding matched the session pattern.
        ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
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
      const effectiveAllowed = (b.allowed_domains ?? [pre.domain]).map(normalizeDomain);

      if (canonicalEnvironment(env) === "production" && effectiveAllowed.length === 0) {
        throw new ShuttleError("missing_allow_domain", "Production secrets require at least one allowed domain.");
      }

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
        ...(pre.page_title !== undefined ? { page_title: pre.page_title } : {}),
        ...(pre.page_url_host !== undefined ? { page_url_host: pre.page_url_host } : {}),
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
    const o = asObject(raw);
    const b = raw as InjectBody;
    reqString(o, "ref");
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");

      const secret = await services.vault.getSecret(b.ref);
      assertSecretActionAllowed(secret, "inject_into_field");
      const pre = await services.browser.readFocusedFingerprintAndDomain();
      if (b.domain !== undefined && !domainMatches(pre.domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Current domain ${pre.domain} != ${b.domain}.`);
      }
      enforceDomain(pre.domain, secret.allowed_domains, "inject");

      if (services.blind.current() !== null) {
        throw new ShuttleError(
          "blind_mode_already_active",
          "Blind mode is already active; run `secret-shuttle blind end` before injecting.",
        );
      }

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
        ...(pre.page_title !== undefined ? { page_title: pre.page_title } : {}),
        ...(pre.page_url_host !== undefined ? { page_url_host: pre.page_url_host } : {}),
      };
      await requireApproval({
        store: services.approvals,
        binding,
        daemonPort: daemonPortRef(),
        ...(b.approval_id !== undefined ? { approvalIdFromClient: b.approval_id } : {}),
        ...(b.wait_for_approval === false ? { waitMs: 0 } : {}),
      });

      // Daemon OWNS the blind window for inject: black out the agent BEFORE the
      // value can ever reach the page. Mirrors /v1/blind/start.
      services.blind.start(pre.domain, "inject");
      if (services.cdp !== null) {
        await disableObservationDomains(services.cdp).catch(() => undefined);
      }
      services.cdpProxy?.severAgentConnections();

      let result: InjectResult;
      try {
        const post = await services.browser.readFocusedFingerprintAndDomain();
        if (post.target_id !== pre.target_id || post.field_fingerprint !== pre.field_fingerprint || post.domain !== pre.domain) {
          throw new ShuttleError("field_changed", "Focused field changed after approval.");
        }
        result = await services.browser.injectFocused(secret.value);
      } catch (preWriteErr) {
        // Failure at or before injectFocused → nothing was written to the page,
        // so it is safe to auto-resume rather than strand the user in blind mode.
        services.blind.end();
        throw preWriteErr;
      }
      // The secret IS now on the page. From here on, a failure must NOT resume
      // observation — blind mode stays ACTIVE until a human-approved `blind end`.
      await services.vault.markUsed(secret.ref);
      await writeDaemonAudit({ action: "inject", ok: true, ref: secret.ref, environment: secret.environment, domain: result.domain });
      return {
        injected: true,
        secret_ref: secret.ref,
        browser_domain: result.domain,
        field: result.field,
        blind_mode: true,
        next: "Secret written with the agent blacked out. Run `secret-shuttle blind end` and approve once the secret is no longer visible to resume observation.",
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
    if (typeof b?.ref === "string") services.compareLimiter.check(b.ref);
    try {
      if (services.browser === null) throw new ShuttleError("browser_not_started", "Run `secret-shuttle browser start` first.");
      const secret = await services.vault.getSecret(b.ref);
      assertSecretActionAllowed(secret, "compare_fingerprint");
      const capture = b.with === "selection"
        ? await services.browser.captureSelection()
        : await services.browser.captureFocused();
      if (b.domain !== undefined && !domainMatches(capture.domain, b.domain)) {
        throw new ShuttleError("domain_mismatch", `Current domain ${capture.domain} != ${b.domain}.`);
      }
      enforceDomain(capture.domain, secret.allowed_domains, "compare");

      const binding: ApprovalBinding = {
        action: "compare",
        ref: secret.ref,
        environment: secret.environment,
        destination_domain: capture.domain,
        target_id: null,
        field_fingerprint: null,
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

      const fpKey = await services.vault.fingerprintKey();
      const matches = fingerprintMatches(capture.value, secret.fingerprint, fpKey);
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

export function enforceDomain(current: string, allowed: string[], action: string): void {
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
