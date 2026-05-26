import { ShuttleError } from "../../shared/errors.js";
import { writeDaemonAudit } from "../audit.js";
import type { BootstrapStore, BatchState, PlanEntry, ResolvedDestination } from "./store.js";
import type { DaemonServices } from "../services.js";
import type { BootstrapAuthority } from "./authority.js";
import type {
  GenerateSecretInput,
  GenerateSecretOpts,
  GenerateSecretResult,
} from "../api/routes/secrets.js";
import type {
  RevealCaptureOpts,
  RevealCaptureResult,
} from "../api/routes/reveal-capture.js";
import type {
  RunTemplateInput,
  RunTemplateOpts,
  RunTemplateResult,
} from "../api/routes/templates.js";

export type GenerateCore = (
  services: DaemonServices,
  daemonPortRef: () => number,
  input: GenerateSecretInput,
  opts: GenerateSecretOpts,
) => Promise<GenerateSecretResult>;

/**
 * The reveal-capture dep uses `any` for input because the bootstrap capture
 * source (kind: "capture", url) does not map 1:1 to RevealCaptureInput (which
 * requires live browser handles). The real integration will derive its own
 * input shape; tests spy on this with a mock that ignores the shape entirely.
 */
export type RevealCore = (
  services: DaemonServices,
  daemonPortRef: () => number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
  opts: RevealCaptureOpts,
) => Promise<RevealCaptureResult>;

export type TemplateCore = (
  services: DaemonServices,
  daemonPortRef: () => number,
  input: RunTemplateInput,
  opts: RunTemplateOpts,
) => Promise<RunTemplateResult>;

export interface ExecutorDeps {
  generateSecret: GenerateCore;
  revealCapture: RevealCore;
  runTemplate: TemplateCore;
  services: DaemonServices;
  daemonPortRef: () => number;
}

export interface ExecuteResult {
  completed: number;
  failed: number;
  refs: string[];
  errors: Array<{
    secret: string;
    step: string;
    code: string;
    message: string;
    destination?: string;
  }>;
}

/**
 * Walks a bootstrap batch plan, calling the appropriate core function for each
 * PlanEntry's source step and then each destination step, all under a
 * BootstrapAuthority so inner routes skip their own requireApprovals call.
 *
 * - Unknown batch → `bootstrap_batch_not_found`.
 * - Already-completed batch → returns cached summary without re-running.
 * - Transitions to "in_progress" before the walk; saves after each entry.
 * - Per-step errors are recorded in step_results; execution continues past
 *   failures (partial-success semantics).
 * - Final status: "completed" or "failed_partial".
 */
export async function executeBatch(
  store: BootstrapStore,
  batchId: string,
  deps: ExecutorDeps,
): Promise<ExecuteResult> {
  const state = await store.get(batchId);
  if (state === null) {
    throw new ShuttleError("bootstrap_batch_not_found", `unknown batch_id: ${batchId}`);
  }
  if (state.status === "completed") {
    return summarize(state);
  }

  state.status = "in_progress";
  await store.save(state);

  const authority: BootstrapAuthority = { batchId };

  for (const entry of state.plan) {
    const prior = state.step_results[entry.secret];
    if (prior?.ok === true) {
      continue;
    }

    try {
      // Reuse prior ref if the source step already completed in an earlier run.
      // This makes destination-only retries safe: we don't re-call
      // generateSecretCore (which would either throw secret_exists or, with
      // --force, clobber a value that downstream destinations may have already
      // consumed correctly).
      const ref =
        prior?.ref !== undefined
          ? prior.ref
          : await runSourceStep(entry, deps, authority);

      // Carry forward any destinations that previously succeeded — they must NOT
      // be re-pushed. Run only the destinations that previously failed or were
      // never attempted.
      const priorDestinations = prior?.destinations_pushed ?? [];
      const successfulPriorByShorthand = new Map<
        string,
        { destination: string; ok: boolean; error_code?: string; message?: string }
      >();
      for (const p of priorDestinations) {
        if (p.ok === true) successfulPriorByShorthand.set(p.destination, p);
      }
      const destinationsToAttempt = entry.destinations.filter(
        (d) => !successfulPriorByShorthand.has(d.shorthand),
      );
      const newAttempts = await runDestinationSteps(destinationsToAttempt, ref, deps, authority);

      // Merge in the ORDER from entry.destinations so downstream consumers see a
      // consistent shape across runs.
      const merged: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }> = entry.destinations.map(
        (d) => successfulPriorByShorthand.get(d.shorthand) ?? newAttempts.find((n) => n.destination === d.shorthand)!,
      );

      const anyDestFailed = merged.some((d) => !d.ok);
      state.step_results[entry.secret] = {
        ok: !anyDestFailed,
        ref,
        destinations_pushed: merged,
        ...(anyDestFailed ? { error_code: "destination_partial_failure" } : {}),
      };
      await writeDaemonAudit({ action: "bootstrap_step", ok: !anyDestFailed, ref });
    } catch (e) {
      const errorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
      const message = e instanceof Error ? e.message : String(e);
      // If we already had a ref from a prior run, preserve it so subsequent
      // retries can still reuse it (don't reset to the source step on a third try).
      state.step_results[entry.secret] = {
        ok: false,
        error_code: errorCode,
        message,
        ...(prior?.ref !== undefined ? { ref: prior.ref } : {}),
        ...(prior?.destinations_pushed !== undefined ? { destinations_pushed: prior.destinations_pushed } : {}),
      };
      await writeDaemonAudit({
        action: "bootstrap_step",
        ok: false,
        ref: prior?.ref ?? entry.ref,
        error_code: errorCode,
      });
    }
    await store.save(state);
  }

  const summary = summarize(state);
  state.status = summary.failed > 0 ? "failed_partial" : "completed";
  await store.save(state);
  return summary;
}

async function runSourceStep(
  entry: PlanEntry,
  deps: ExecutorDeps,
  authority: BootstrapAuthority,
): Promise<string> {
  if (entry.source.kind === "existing") {
    // No generation needed — the ref already exists in the vault.
    return entry.source.ref!;
  }

  if (entry.source.kind === "random_32_bytes" || entry.source.kind === "random_64_bytes") {
    const result = await deps.generateSecret(
      deps.services,
      deps.daemonPortRef,
      {
        name: entry.secret,
        environment: refEnvFromRef(entry.ref),
        source: refSourceFromRef(entry.ref),
        kind: entry.source.kind,
        allowedDomains: entry.destinations.map((d) => d.domain),
        ...(entry.force === true ? { force: true } : {}),
      },
      { bootstrapAuthority: authority },
    );
    return result.secret_ref;
  }

  if (entry.source.kind === "capture") {
    // The capture flow requires live browser handles (set up by the user before
    // running bootstrap). We pass the plan entry's ref and url; the dep
    // implementation is responsible for constructing the full RevealCaptureInput
    // from whatever browser handles are available at that point.
    const result = await deps.revealCapture(
      deps.services,
      deps.daemonPortRef,
      { ref: entry.ref, url: entry.source.url! },
      { bootstrapAuthority: authority },
    );
    if (!("secret_ref" in result)) {
      throw new ShuttleError(
        "bootstrap_plan_invalid",
        `reveal-capture returned blind_mode=true for ${entry.secret}; manual recovery required`,
      );
    }
    return result.secret_ref;
  }

  throw new ShuttleError(
    "bootstrap_plan_invalid",
    `unknown source.kind: ${(entry.source as { kind: string }).kind}`,
  );
}

async function runDestinationSteps(
  destinations: ResolvedDestination[],
  ref: string,
  deps: ExecutorDeps,
  authority: BootstrapAuthority,
): Promise<Array<{ destination: string; ok: boolean; error_code?: string; message?: string }>> {
  const results: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }> = [];
  for (const dest of destinations) {
    try {
      const result = await deps.runTemplate(
        deps.services,
        deps.daemonPortRef,
        {
          templateId: dest.template_id,
          ref,
          params: dest.template_params,
        },
        { bootstrapAuthority: authority },
      );
      if (result.exit_code !== 0) {
        results.push({
          destination: dest.shorthand,
          ok: false,
          error_code: "template_exec_failed",
          message: `template ${dest.template_id} exited with code ${result.exit_code}`,
        });
      } else {
        results.push({ destination: dest.shorthand, ok: true });
      }
    } catch (e) {
      results.push({
        destination: dest.shorthand,
        ok: false,
        error_code: e instanceof ShuttleError ? e.code : "unexpected_error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/** Extract vault source name from a ss:// ref (ss://<source>/<env>/<name>). */
function refSourceFromRef(ref: string): string {
  const m = ref.match(/^ss:\/\/([^/]+)\/[^/]+\/[^/]+$/);
  return m?.[1] ?? "local";
}

/**
 * Extract environment from a ss:// ref and expand short aliases.
 * ss://<source>/<env>/<name> — maps prod→production, dev→development, etc.
 */
function refEnvFromRef(ref: string): string {
  const m = ref.match(/^ss:\/\/[^/]+\/([^/]+)\/[^/]+$/);
  const short = m?.[1];
  if (short === "prod") return "production";
  if (short === "dev") return "development";
  if (short === "preview") return "preview";
  return short ?? "production";
}

function summarize(state: BatchState): ExecuteResult {
  let completed = 0;
  let failed = 0;
  const refs: string[] = [];
  const errors: Array<{
    secret: string;
    step: string;
    code: string;
    message: string;
    destination?: string;
  }> = [];

  for (const entry of state.plan) {
    const r = state.step_results[entry.secret];
    if (r === undefined) continue;
    if (r.ok) {
      completed += 1;
      if (r.ref !== undefined) refs.push(r.ref);
    } else {
      failed += 1;
      if (r.destinations_pushed !== undefined && r.destinations_pushed.length > 0) {
        // Destination-level failures: emit one error entry per failed destination.
        for (const dest of r.destinations_pushed) {
          if (!dest.ok) {
            errors.push({
              secret: entry.secret,
              step: "destination",
              code: dest.error_code ?? "unexpected_error",
              message: dest.message ?? "",
              destination: dest.destination,
            });
          }
        }
      } else {
        // Source-step failure (or unexpected error with no destination detail).
        errors.push({
          secret: entry.secret,
          step: "execute",
          code: r.error_code ?? "unexpected_error",
          message: r.message ?? "",
        });
      }
    }
  }

  return { completed, failed, refs, errors };
}
