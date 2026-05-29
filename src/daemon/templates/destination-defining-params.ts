/**
 * Per-template "destination-defining params" config used by the
 * session-derivation path in Burst 5 (§2 "Pattern derivation"). Each
 * template's destination-defining params are declared in the template's
 * own definition file via `sessionDefiningParams: readonly string[]`
 * (added to TemplateDefinition in this task — see registry.ts).
 *
 * `DESTINATION_DEFINING_PARAMS` below is DERIVED from those per-template
 * declarations at module load time — there is no second source of truth
 * to keep in sync. If a template ships without `sessionDefiningParams`,
 * provision-derived sessions exclude it (fail-closed) AND the daemon
 * startup validator logs a warning.
 *
 * `name` is universally destination-defining (the env-var / secret name
 * set at the provider).
 *
 * See spec §2 "Template-param constraint primitive".
 */
import { TemplateRegistry, type TemplateDefinition } from "./registry.js";

// Module-load-time derivation. The TemplateRegistry constructor populates
// itself with the four built-ins; we read each template's
// sessionDefiningParams once and freeze the resulting map. This map is
// the cached lookup surface for `destinationDefiningParamsFor()` — but
// it is NOT the source of truth (each template file is). Templates
// registered dynamically at runtime (via TemplateRegistry.register, used
// only by tests) are NOT reflected here; tests that need to validate
// such templates pass an explicit registry instance to
// `validateDestinationDefiningParamsCoverage`.
const _bootstrapRegistry = new TemplateRegistry();
export const DESTINATION_DEFINING_PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    _bootstrapRegistry.list()
      .filter((t): t is TemplateDefinition & { sessionDefiningParams: readonly string[] } =>
        t.sessionDefiningParams !== undefined,
      )
      .map((t) => [t.id, t.sessionDefiningParams] as const),
  ),
);

/**
 * Returns the destination-defining param keys for a template_id, OR
 * null if the template is not registered (or has no
 * sessionDefiningParams declaration). Session derivation treats null
 * as "exclude this destination from the derivation (fail-closed)."
 */
export function destinationDefiningParamsFor(template_id: string): readonly string[] | null {
  // Under noUncheckedIndexedAccess, index access yields `T | undefined`.
  // Explicit coalesce keeps the declared return type accurate.
  const keys = DESTINATION_DEFINING_PARAMS[template_id];
  return keys ?? null;
}

export interface Logger {
  warn(msg: string): void;
}

const defaultLogger: Logger = {
  warn: (msg) => console.warn(`[secret-shuttle] ${msg}`),
};

/**
 * Validate that every shipped template (every entry in the supplied
 * `TemplateRegistry`) declares its own `sessionDefiningParams` field.
 * Called once at daemon startup with the module-scoped registry from
 * src/daemon/api/routes/templates.ts (no `services.templates` field exists).
 * Emits a warning line for each template missing the declaration —
 * provision-derived sessions for that template will be excluded
 * (fail-closed).
 *
 * The validator takes a registry instance (rather than reading the
 * module-scoped one) so tests can register stub templates and exercise
 * the warning path. See destination-defining-params.test.ts.
 */
export function validateDestinationDefiningParamsCoverage(
  registry: TemplateRegistry,
  logger: Logger = defaultLogger,
): void {
  for (const t of registry.list()) {
    if (t.sessionDefiningParams === undefined) {
      logger.warn(
        `Template '${t.id}' has no sessionDefiningParams declaration. ` +
        `Provision-derived sessions will exclude this template (fail-closed). ` +
        `Add 'sessionDefiningParams: [...] as const' to the template definition.`,
      );
    }
  }
}
