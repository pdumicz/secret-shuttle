import type { ServerResponse } from "node:http";
import { ShuttleError, errorToJson } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import { buildChildEnv } from "../../safe-env.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { spawnAndStream, type OutputWriter } from "../../run/spawner.js";
import { createMasker } from "../../run/masker.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { writeDaemonAudit } from "../../audit.js";
import { asObject, optBool, optString, reqString } from "../validate.js";
import path from "node:path";

interface RunResolveBody {
  refs: string[];
  env: Array<{ key: string; value: string; isRef: boolean }>;
  command: string;
  args: string[];
  cwd: string;
  approval_id?: string;
  wait_for_approval?: boolean;
  session_id?: string;
}

export function registerRunResolveRoute(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRouteStreaming("POST", "/v1/run/resolve", async (_req, raw, res) => {
    // Body parsing + Host + bearer-token + 1 MB cap are enforced by
    // DaemonServer.addRouteStreaming before this handler runs.

    services.lock.requireKey();

    // Hoisted OUTSIDE the production block so its session_id (if any) flows
    // into EVERY audit emission below — both pre-spawn failure paths (where
    // grant remains undefined for non-production refs) and the post-spawn
    // success/failure paths. For the run action this only ever holds a
    // single-use grant (run is NOT a SessionAction; the session matcher
    // refuses and requireApproval falls back), so grant.session_id is
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

      const approvalId = optString(o, "approval_id");
      const waitForApproval = optBool(o, "wait_for_approval");
      const sessionId = optString(o, "session_id");

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
        ...(approvalId !== undefined ? { approval_id: approvalId } : {}),
        ...(waitForApproval !== undefined ? { wait_for_approval: waitForApproval } : {}),
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
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
    let resolved: Awaited<ReturnType<typeof services.vault.resolveRefs>>;
    try {
      resolved = await services.vault.resolveRefs(body.refs);
    } catch (e) {
      const code = e instanceof ShuttleError ? e.code : "unexpected_error";
      await auditPerRequestedRef(body.refs, false, code, grant?.session_id);
      writeJsonError(res, 400, e);
      return;
    }

    // Enforce per-secret use_as_stdin action. Fails closed BEFORE the spawner runs.
    try {
      for (const record of resolved.values()) {
        assertSecretActionAllowed(record, "use_as_stdin");
      }
    } catch (e) {
      const code = e instanceof ShuttleError ? e.code : "unexpected_error";
      // We have full records here, so audit with environment populated.
      await auditPerRef(body.refs, resolved, false, code, grant?.session_id);
      writeJsonError(res, 400, e);
      return;
    }

    // Determine production gating from canonical ref env (ss://source/env/name).
    const isProduction = Array.from(resolved.values()).some(
      (r) => r.environment === "production",
    );

    if (isProduction) {
      const binding: ApprovalBinding = {
        action: "run",
        ref: null,
        environment: "production",
        destination_domain: null,
        target_id: null,
        field_fingerprint: null,
        template_id: null,
        // Stash the ref list + command in template_params for UI display.
        template_params: {
          command: body.command,
          args: JSON.stringify(body.args),
          refs: body.refs.join(","),
        },
        allowed_domains: [],
      };
      try {
        grant = await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          sessionStore: services.sessionStore,
          openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
          ...(body.session_id !== undefined ? { sessionId: body.session_id } : {}),
          ...(body.approval_id !== undefined ? { approvalIdFromClient: body.approval_id } : {}),
          ...(body.wait_for_approval === false ? { waitMs: 0 } : {}),
        });
      } catch (e) {
        // Approval failed (denied, expired, required-but-no-wait). Audit per ref.
        // grant?.session_id is undefined here unless the session fast-path
        // succeeded — for the run binding, the matcher always refuses (run is
        // NOT a SessionAction), so the spread evaluates to nothing.
        await auditPerRef(body.refs, resolved, false, e instanceof ShuttleError ? e.code : "unexpected_error", grant?.session_id);
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
          await auditPerRef(body.refs, resolved, false, "secret_not_found", grant?.session_id);
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
    });

    // markUsed + audit AFTER the child exits. Success criterion: child exit == 0.
    // These run BEFORE res.end() so the response close happens-after the side
    // effects — a fetch caller that awaits the response body to completion can
    // safely inspect last_used_at and the audit log without racing.
    const ok = childExitCode === 0;
    for (const ref of resolved.keys()) {
      await services.vault.markUsed(ref).catch(() => undefined);
    }
    await auditPerRef(body.refs, resolved, ok, ok ? undefined : "child_exit_nonzero", grant?.session_id);

    // Close the response only if we still can. On the cancel path, res is
    // already destroyed/ended — writableEnded check prevents the double-end
    // that would otherwise emit ERR_STREAM_WRITE_AFTER_END.
    if (!responseClosed && !res.destroyed && !res.writableEnded) {
      res.end();
    }
  });

  async function auditPerRef(
    refs: readonly string[],
    resolved: Awaited<ReturnType<typeof services.vault.resolveRefs>>,
    ok: boolean,
    errorCode: string | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    for (const ref of refs) {
      const record = resolved.get(ref);
      await writeDaemonAudit({
        action: "run",
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
   */
  async function auditPerRequestedRef(
    refs: readonly string[],
    ok: boolean,
    errorCode: string | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    for (const ref of refs) {
      await writeDaemonAudit({
        action: "run",
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
