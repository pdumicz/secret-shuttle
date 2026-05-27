import type { ServerResponse } from "node:http";
import { ShuttleError, errorToJson } from "../../../shared/errors.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import { buildChildEnv } from "../../safe-env.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { spawnAndStream, type OutputWriter } from "../../run/spawner.js";
import { createMasker } from "../../run/masker.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { writeDaemonAudit } from "../../audit.js";
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
import { parseSecretRef } from "../../../shared/refs.js";
import path from "node:path";

interface RunResolveBody {
  refs: string[];
  env: Array<{ key: string; value: string; isRef: boolean }>;
  command: string;
  args: string[];
  cwd: string;
  approval_ids?: string[];
  wait_for_approval?: boolean;
  session_id?: string;
  /**
   * Plan 4c: optional ss:// ref whose plaintext value is piped to the child's
   * stdin (fd 0). Must NOT also appear in `refs` (the route rejects that with
   * stdin_ref_in_env_file before any vault work). The CLI never sees the
   * value — the daemon resolves and writes it.
   */
  stdin_ref?: string;
}

export function registerRunResolveRoute(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRouteStreaming("POST", "/v1/run/resolve", async (_req, raw, res) => {
    // Body parsing + Host + bearer-token + 1 MB cap are enforced by
    // DaemonServer.addRouteStreaming before this handler runs.

    services.lock.assertUnlocked();

    // Hoisted OUTSIDE the production block so its session_id (if any) flows
    // into EVERY audit emission below — both pre-spawn failure paths (where
    // grant remains undefined for non-production refs) and the post-spawn
    // success/failure paths. For the run action this only ever holds a
    // single-use grant (run is NOT a SessionAction; the session matcher
    // refuses and requireApprovals falls back), so grant.session_id is
    // ALWAYS undefined and the conditional spread evaluates to nothing —
    // but we still wire the spread to preserve a single audit shape across
    // all routes.
    let grant: ApprovalGrant | undefined;

    // Strict body validation. Reject — never silently coerce or drop — anything
    // that doesn't match the wire contract. The existing route validators in
    // src/daemon/api/routes/secrets-delete.ts and templates.ts follow this same
    // pattern: throw bad_request / missing_param at the first malformed field.
    let body: RunResolveBody;
    try {
      const o = asObject(raw);

      // refs: optional array of strings.
      let refs: string[] = [];
      if (o["refs"] !== undefined) {
        if (!Array.isArray(o["refs"])) {
          throw new ShuttleError("bad_request", "refs must be an array of strings.");
        }
        for (const r of o["refs"]) {
          if (typeof r !== "string") {
            throw new ShuttleError("bad_request", "refs entries must be strings.");
          }
        }
        refs = o["refs"] as string[];
      }

      // env: optional array of { key: string, value: string, isRef: boolean }.
      const envEntries: Array<{ key: string; value: string; isRef: boolean }> = [];
      if (o["env"] !== undefined) {
        if (!Array.isArray(o["env"])) {
          throw new ShuttleError("bad_request", "env must be an array of entry objects.");
        }
        for (const e of o["env"]) {
          if (e === null || typeof e !== "object") {
            throw new ShuttleError("bad_request", "env entries must be objects.");
          }
          const ent = e as Record<string, unknown>;
          if (typeof ent["key"] !== "string") {
            throw new ShuttleError("bad_request", "env entry 'key' must be a string.");
          }
          if (typeof ent["value"] !== "string") {
            throw new ShuttleError("bad_request", "env entry 'value' must be a string.");
          }
          if (typeof ent["isRef"] !== "boolean") {
            throw new ShuttleError("bad_request", "env entry 'isRef' must be a boolean.");
          }
          envEntries.push({
            key: ent["key"] as string,
            value: ent["value"] as string,
            isRef: ent["isRef"] as boolean,
          });
        }
      }

      // args: optional array of strings.
      let args: string[] = [];
      if (o["args"] !== undefined) {
        if (!Array.isArray(o["args"])) {
          throw new ShuttleError("bad_request", "args must be an array of strings.");
        }
        for (const a of o["args"]) {
          if (typeof a !== "string") {
            throw new ShuttleError("bad_request", "args entries must be strings.");
          }
        }
        args = o["args"] as string[];
      }

      const approvalIds = optApprovalIds(o);
      const waitForApproval = optBool(o, "wait_for_approval");
      const sessionId = optString(o, "session_id");

      // Plan 4c: optional stdin_ref. Validate its ss:// shape NOW (before any
      // vault work) so a malformed ref surfaces as a clean pre-stream
      // bad_request, and check for duplication with the env refs.
      //
      // parseSecretRef throws ShuttleError("invalid_ref", ...) on malformed
      // input; we translate that to bad_request to match the plan contract
      // "stdin_ref malformed → bad_request" — invalid_ref would conflate this
      // with a separate code path (resolveRefs's own invalid_ref handling).
      const stdinRefRaw = optString(o, "stdin_ref");
      let stdinRefCanonical: string | undefined;
      if (stdinRefRaw !== undefined) {
        // parseSecretRef returns the canonicalized form via `.ref` (built by
        // buildSecretRef: lowercase source, short environment alias, exact
        // name). The vault resolver, env-file parser, and audit log all key
        // off this canonical form — using the raw user-typed string would
        // (a) miss the dup-guard when env refs are canonical and stdin_ref
        // isn't, and (b) crash at `resolved.get(body.stdin_ref)!` because
        // the resolved map is keyed on canonical refs.
        try {
          stdinRefCanonical = parseSecretRef(stdinRefRaw).ref;
        } catch {
          throw new ShuttleError(
            "bad_request",
            "stdin_ref must be a valid ss:// reference (ss://source/environment/name).",
          );
        }
        // Duplicate-ref guard: same ref in BOTH env_refs and stdin_ref is
        // almost certainly a user mistake (env_file and --stdin both pointing
        // at the same secret). Fail closed with a distinct code so the CLI
        // can surface a precise hint — and BEFORE the resolve batch so the
        // user gets a fast 400 with no vault work.
        //
        // Compare the CANONICAL stdin ref against env refs. Env refs are
        // already canonical at this point (parseEnvFile canonicalizes them
        // upstream), so includes() with the canonical stdin form catches
        // duplicates that differ only in surface form (uppercase source,
        // long environment alias, etc.).
        if (refs.includes(stdinRefCanonical)) {
          throw new ShuttleError(
            "stdin_ref_in_env_file",
            `stdin_ref ${stdinRefCanonical} also appears in env refs. Use one mechanism, not both.`,
          );
        }
      }

      // cwd is required AND must be absolute. Use optString here (not reqString)
      // so a missing cwd flows into the explicit `missing_param` check below,
      // matching the plan contract for "cwd MUST be absolute. Reject missing_param
      // if missing or relative." A non-string is still a `bad_request` (reaches
      // through optString's check) — this branch only flips the missing-key
      // contract from bad_request → missing_param.
      const cwdOpt = optString(o, "cwd");

      body = {
        refs,
        env: envEntries,
        command: reqString(o, "command"),
        args,
        cwd: cwdOpt ?? "",
        ...(approvalIds !== undefined ? { approval_ids: approvalIds } : {}),
        ...(waitForApproval !== undefined ? { wait_for_approval: waitForApproval } : {}),
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
        ...(stdinRefCanonical !== undefined ? { stdin_ref: stdinRefCanonical } : {}),
      };
    } catch (e) {
      // Validation throws before any side effect — safe to surface as pre-stream JSON.
      writeJsonError(res, 400, e);
      return;
    }

    if (body.cwd.length === 0) {
      writeJsonError(res, 400, new ShuttleError("missing_param", "cwd is required."));
      return;
    }
    if (!path.isAbsolute(body.cwd)) {
      writeJsonError(res, 400, new ShuttleError("missing_param", "cwd must be an absolute path."));
      return;
    }
    if (body.command.length === 0) {
      writeJsonError(res, 400, new ShuttleError("missing_param", "command is required."));
      return;
    }

    // Resolve every ref. Deleted refs throw secret_not_found here.
    // SECURITY: audit pre-spawn failures per ref. Denied use of a real OR
    // fictitious ref is security-relevant (a probe). We don't have full
    // SecretRecords for missing refs, but we DO have the requested ref string.
    //
    // Plan 4c: include stdin_ref in the same batch so the route's existing
    // resolve / assertSecretActionAllowed / markUsed loops naturally cover
    // it. The duplicate-ref guard above guarantees stdin_ref ∉ body.refs, so
    // the two are disjoint within the resolved map.
    const allRefs = body.stdin_ref !== undefined ? [body.stdin_ref, ...body.refs] : body.refs;
    let resolved: Awaited<ReturnType<typeof services.vault.resolveRefs>>;
    try {
      resolved = await services.vault.resolveRefs(allRefs);
    } catch (e) {
      const code = e instanceof ShuttleError ? e.code : "unexpected_error";
      await auditPerRequestedRef(allRefs, body.stdin_ref, false, code, grant?.session_id);
      writeJsonError(res, 400, e);
      return;
    }

    // Enforce per-secret use_as_stdin action. Fails closed BEFORE the spawner runs.
    // Both env refs and the optional stdin ref are gated by the SAME action
    // ("use_as_stdin") — the daemon writes the resolved bytes into the child's
    // environment or stdin, and either path lets the child observe the value.
    try {
      for (const record of resolved.values()) {
        assertSecretActionAllowed(record, "use_as_stdin");
      }
    } catch (e) {
      const code = e instanceof ShuttleError ? e.code : "unexpected_error";
      // We have full records here, so audit with environment populated.
      await auditPerRef(allRefs, body.stdin_ref, resolved, false, code, grant?.session_id);
      writeJsonError(res, 400, e);
      return;
    }

    // Approval gating via multi-binding requireApprovals (Plan 4d).
    // Env refs and the stdin ref require SEPARATE approval bindings (different
    // actions imply different UI copy, audit lines, session-matcher rules).
    // requireApprovals handles atomicity: under --no-wait with mints needed for
    // either binding, it mints both atomically and surfaces details.approvals
    // with both IDs. The legacy single requireApprovals pattern with envApprovalRan
    // flag bookkeeping is no longer needed.
    const envProductionRefs = body.refs.filter(
      (r) => resolved.get(r)!.environment === "production",
    );

    const bindings: ApprovalBinding[] = [];

    // Env binding first, stdin binding second — deterministic order. requireApprovals
    // preserves this order in the returned grants array and in details.approvals,
    // which downstream code (session_id propagation, audit logs) relies on.
    if (envProductionRefs.length > 0) {
      const envBinding: ApprovalBinding = {
        action: "run",
        ref: null,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        // template_params carries display data for the hub UI (no template_id needed).
        template_params: {
          command: body.command,
          args: JSON.stringify(body.args),
          refs: body.refs.join(","),
        },
        allowed_domains: [],
      };
      bindings.push(envBinding);
    }

    if (body.stdin_ref !== undefined && resolved.get(body.stdin_ref)!.environment === "production") {
      const stdinBinding: ApprovalBinding = {
        action: "run_stdin",
        ref: body.stdin_ref,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        // template_params carries display data for the hub UI (no template_id needed).
        template_params: {
          command: body.command,
          args: JSON.stringify(body.args),
          ref: body.stdin_ref,
        },
        allowed_domains: [],
      };
      bindings.push(stdinBinding);
    }

    if (bindings.length > 0) {
      try {
        const grants = await requireApprovals({
          store: services.approvals,
          bindings,
          daemonPort: daemonPortRef(),
          sessionStore: services.sessionStore,
          openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
          ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
          ...(body.approval_ids !== undefined ? { approvalIdsFromClient: body.approval_ids } : {}),
          ...(body.wait_for_approval === false ? { waitMs: 0 } : {}),
        });
        // session_id propagation: any grant with session_id wins; default to first.
        // In practice, run and run_stdin are NOT in CANONICAL_MAP (session.ts), so
        // canMatchSession always returns false for both bindings and neither grant
        // ever has a session_id today. The find() is forward-compat for when/if
        // run-resolve-eligible actions gain session support. ApprovalGrant.session_id
        // is `string | undefined` (store.ts:56).
        grant = grants.find((g) => g.session_id !== undefined) ?? grants[0];
      } catch (e) {
        await auditPerRef(allRefs, body.stdin_ref, resolved, false, e instanceof ShuttleError ? e.code : "unexpected_error", grant?.session_id);
        writeJsonError(res, 400, e);
        return;
      }
    }

    // Build the child env: hardened-PATH baseline + non-refs + resolved refs.
    const env: NodeJS.ProcessEnv = { ...buildChildEnv() };
    for (const entry of body.env) {
      if (entry.isRef) {
        const record = resolved.get(entry.value);
        if (record === undefined) {
          // Should not happen — resolveRefs would have thrown — but guard anyway.
          await auditPerRef(allRefs, body.stdin_ref, resolved, false, "secret_not_found", grant?.session_id);
          writeJsonError(res, 400, new ShuttleError("secret_not_found", `Ref ${entry.value} could not be resolved.`));
          return;
        }
        env[entry.key] = record.value;
      } else {
        env[entry.key] = entry.value;
      }
    }

    // Build TWO maskers (one per stream) from the resolved values (NOT the
    // refs — refs are public). A single shared masker would (a) hold back
    // stdout tail bytes across stderr writes, (b) emit those held-back bytes
    // to whichever stream wrote next, mixing the two streams, and (c) at
    // flush time, dump everything to one stream regardless of origin.
    const secretValues = Array.from(resolved.values()).map((r) => r.value);
    const stdoutMasker = createMasker(secretValues);
    const stderrMasker = createMasker(secretValues);

    // NOTE: maskers are disposed in the finally below. dispose() itself is
    // unit-tested in src/daemon/run/masker-scrub.test.ts; the wire-up here
    // is verified by code review (Burst 4 cleanup pass). dispose() scrubs
    // the pattern Buffers (raw secret bytes) and the lookback Buffer via
    // .fill(0) so the bytes don't linger until GC after the request ends.
    try {
      // Switch into streaming response mode.
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      res.setHeader("cache-control", "no-store");
      res.flushHeaders();

      // Track whether the client has disconnected. This is the source of truth
      // for "can we still write to res?" — on cancellation, the chain is:
      //   client aborts fetch
      //   → res.on('close') fires (responseClosed = true; abort the spawner)
      //   → spawner SIGTERMs the child
      //   → child exits
      //   → spawnAndStream resolves
      //   → spawner calls writer.writeExit(code)  ← THIS write must be skipped
      //
      // Without these guards, writer.writeExit would call res.write() on a
      // destroyed socket → Node emits ERR_STREAM_WRITE_AFTER_END / crashes the
      // daemon if it isn't handled. We belt-and-braces with both the explicit
      // `responseClosed` flag AND res.destroyed / res.writableEnded checks so we
      // ALSO skip writes if some other Node-internal path destroys res first.
      let responseClosed = false;
      const isWritable = (): boolean =>
        !responseClosed && !res.destroyed && !res.writableEnded;

      const writer: OutputWriter = {
        writeStdout(chunk) {
          const masked = stdoutMasker.process(chunk);
          if (masked.length === 0 || !isWritable()) return;
          res.write(JSON.stringify({ stream: "stdout", data: masked.toString("base64") }) + "\n");
        },
        writeStderr(chunk) {
          const masked = stderrMasker.process(chunk);
          if (masked.length === 0 || !isWritable()) return;
          res.write(JSON.stringify({ stream: "stderr", data: masked.toString("base64") }) + "\n");
        },
        writeExit(code) {
          // Flush each masker to ITS OWN stream — no cross-stream emission.
          // Even if the response is closed, we still call masker.flush() so the
          // masker state resets cleanly; we just don't write the bytes.
          const stdoutFlush = stdoutMasker.flush();
          const stderrFlush = stderrMasker.flush();
          if (!isWritable()) return;
          if (stdoutFlush.length > 0) {
            res.write(JSON.stringify({ stream: "stdout", data: stdoutFlush.toString("base64") }) + "\n");
          }
          if (stderrFlush.length > 0) {
            res.write(JSON.stringify({ stream: "stderr", data: stderrFlush.toString("base64") }) + "\n");
          }
          res.write(JSON.stringify({ exit: code }) + "\n");
          // NOTE: do NOT call res.end() here. The route handler ends the
          // response AFTER markUsed + auditPerRef complete so a test (or a
          // pipeline consumer) that observes the response close can safely
          // read updated last_used_at and audit entries. Calling res.end()
          // here would race with the post-spawn async work that runs after
          // spawnAndStream resolves.
        },
        writeError(err) {
          if (!isWritable()) return;
          // Forward exit_code on the wire so the CLI's daemonErrorFromPayload
          // path picks it up — without this, spawn_failed would fall back to
          // the registry default (TRANSIENT=1) and `run -- missing-binary`
          // would exit 1 instead of the POSIX-canonical 127.
          const errorPayload: { code: string; message: string; exit_code?: number } = {
            code: err.code,
            message: err.message,
          };
          if (err.exit_code !== undefined) errorPayload.exit_code = err.exit_code;
          res.write(JSON.stringify({ error: errorPayload }) + "\n");
        },
      };

      // CLI disconnect → abort → SIGTERM child (5s grace) → SIGKILL.
      const abortController = new AbortController();
      res.on("close", () => {
        responseClosed = true;
        abortController.abort();
      });

      let childExitCode = 0;
      // Plan 4c: thread the resolved stdin value into the spawner via stdinBytes.
      // The exactOptionalPropertyTypes flag means we can't pass `stdinBytes: undefined`
      // when the field is optional — use the optional-spread idiom instead.
      // The bytes themselves are NEVER seen by the CLI; the daemon writes them
      // directly to the child's fd 0 (see spawner.ts).
      const stdinBytes = body.stdin_ref !== undefined
        ? Buffer.from(resolved.get(body.stdin_ref)!.value, "utf8")
        : undefined;
      await spawnAndStream({
        cmd: body.command,
        args: body.args,
        env,
        cwd: body.cwd,
        outputWriter: {
          ...writer,
          writeExit(code) {
            childExitCode = code;
            writer.writeExit(code);
          },
        },
        signal: abortController.signal,
        ...(stdinBytes !== undefined ? { stdinBytes } : {}),
      });

      // markUsed + audit AFTER the child exits. Success criterion: child exit == 0.
      // These run BEFORE res.end() so the response close happens-after the side
      // effects — a fetch caller that awaits the response body to completion can
      // safely inspect last_used_at and the audit log without racing.
      const ok = childExitCode === 0;
      for (const ref of resolved.keys()) {
        await services.vault.markUsed(ref).catch(() => undefined);
      }
      await auditPerRef(allRefs, body.stdin_ref, resolved, ok, ok ? undefined : "child_exit_nonzero", grant?.session_id);

      // Close the response only if we still can. On the cancel path, res is
      // already destroyed/ended — writableEnded check prevents the double-end
      // that would otherwise emit ERR_STREAM_WRITE_AFTER_END.
      if (!responseClosed && !res.destroyed && !res.writableEnded) {
        res.end();
      }
    } finally {
      // Scrub pattern Buffers + lookback Buffer. After dispose, the maskers
      // are unusable — but that's fine: the response has already been sent
      // (success path) or aborted (error / client-disconnect paths). flush()
      // during writeExit already self-sanitized the lookback for normal
      // exits; dispose() now covers ALL paths and additionally scrubs the
      // pattern Buffers that flush() does not touch.
      stdoutMasker.dispose();
      stderrMasker.dispose();
    }
  });

  /**
   * Plan 4c: discriminate the audit action per-ref. The stdin ref (if any)
   * audits as `run_stdin`; all other refs audit as `run`. The shape is
   * otherwise identical — same fields, same conditional spreads.
   */
  async function auditPerRef(
    refs: readonly string[],
    stdinRef: string | undefined,
    resolved: Awaited<ReturnType<typeof services.vault.resolveRefs>>,
    ok: boolean,
    errorCode: string | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    for (const ref of refs) {
      const record = resolved.get(ref);
      const action = ref === stdinRef ? "run_stdin" : "run";
      await writeDaemonAudit({
        action,
        ok,
        ref,
        ...(record !== undefined ? { environment: record.environment } : {}),
        ...(errorCode !== undefined ? { error_code: errorCode } : {}),
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      });
    }
  }

  /**
   * Audit per requested-ref WITHOUT a resolved-record map. Used when
   * resolveRefs failed and we have no environment info — we still want to
   * log the attempted use (a denied or non-existent ref is a probe).
   *
   * Plan 4c: also discriminates `run_stdin` vs `run` per-ref so a probe of
   * a non-existent stdin_ref is logged with the action that was actually
   * requested.
   */
  async function auditPerRequestedRef(
    refs: readonly string[],
    stdinRef: string | undefined,
    ok: boolean,
    errorCode: string | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    for (const ref of refs) {
      const action = ref === stdinRef ? "run_stdin" : "run";
      await writeDaemonAudit({
        action,
        ok,
        ref,
        ...(errorCode !== undefined ? { error_code: errorCode } : {}),
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      });
    }
  }
}

/**
 * Write a structured JSON error response before streaming has started.
 * Single-sources the Plan 1 contract via `errorToJson` — preserves both the
 * nested `error: { code, message }` block AND the flat `error_code` /
 * `message` / `hint` / `exit_code` fields. Non-ShuttleError throws come back
 * as `{ error_code: "unexpected_error", exit_code: 1 }` from the registry.
 *
 * Caller is responsible for choosing `status` per HTTP semantics (400 for
 * client errors, 401 for unauthorized — but auth is already enforced by
 * addRouteStreaming, so most route-side writes are 400 here).
 */
function writeJsonError(res: ServerResponse, status: number, err: unknown): void {
  if (res.headersSent) return; // Streaming already began — caller mis-ordered the error path.
  const payload = errorToJson(err);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}
