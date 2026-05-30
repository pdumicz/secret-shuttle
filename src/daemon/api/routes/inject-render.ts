import { mkdir, lstat, realpath, rename, rm, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApprovals } from "../../approvals/require-approvals.js";
import { makeHubOpenUrlImpl } from "../../hub/route-helpers.js";
import type { ApprovalBinding, ApprovalGrant } from "../../approvals/store.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { parseTemplate } from "../../inject/template.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { writeDaemonAudit } from "../../audit.js";
import { asObject, optApprovalIds, optBool, optString, reqString } from "../validate.js";
import type { AgentSecretMetadata, ResolvedSecret } from "../../../vault/types.js";

export function registerInjectRenderRoute(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/inject/render", async (_req, raw) => {
    services.lock.assertUnlocked();

    const o = asObject(raw);
    const template = reqString(o, "template");
    const outputPath = reqString(o, "output_path");
    const approvalIds = optApprovalIds(o);
    const waitForApproval = optBool(o, "wait_for_approval");
    const sessionId = optString(o, "session_id");

    const parsed = parseTemplate(template);

    // Per-ref audit at the END must always fire — declare these outside the try
    // so the finally block sees them. `metaByRef` may still be undefined if the
    // metadata preflight throws (deleted ref → secret_not_found); the finally
    // block tolerates that.
    // valueVisibleToAgent tracks ACTUAL exposure: it stays false until we are
    // about to return rendered content in the response body (stdout-passthrough
    // success path). Any failure — including a failed `inject -o -` — leaves it
    // false because no plaintext ever reached the CLI.
    // Burst 7 §2 (5q): the pre-approval preflight resolves METADATA ONLY
    // (metaByRef, no SecretValue). The plaintext map (`resolved`) is allocated
    // only AFTER the conditional approval gate, immediately before the render
    // sink, and disposed in the finally.
    let metaByRef: Map<string, AgentSecretMetadata> | undefined;
    let resolved: Map<string, ResolvedSecret> | undefined;
    let auditOk = false;
    let auditErrorCode: string | undefined;
    let valueVisibleToAgent = false;
    // grant is hoisted so the finally-block audit can carry session_id when
    // applicable. inject_render is NOT a SessionAction in v0.2.0 — the matcher
    // canonicalizes the action to null and refuses; requireApproval falls back
    // to single-use and grant.session_id is undefined. The conditional spread
    // in the audit write evaluates to nothing on that path, but we still wire
    // the spread to preserve a single audit shape across all routes.
    let grant: ApprovalGrant | undefined;

    try {
      // Burst 7 §2 (5q): metadata-only preflight — no SecretValue, no plaintext
      // string held across the conditional approval gate. Deleted refs throw
      // secret_not_found here.
      metaByRef = new Map();
      for (const ref of parsed.refs) {
        if (metaByRef.has(ref)) continue; // dedupe
        metaByRef.set(ref, await services.vault.inspect(ref));
      }
      // Enforce policy per ref BEFORE the approval gate — fail closed without
      // prompting if any opted-out of use_as_stdin.
      for (const record of metaByRef.values()) {
        assertSecretActionAllowed(record, "use_as_stdin");
      }

      const isProduction = Array.from(metaByRef.values()).some(
        (r) => r.environment === "production",
      );

      if (isProduction) {
        const binding: ApprovalBinding = {
          action: "inject_render",
          ref: null,
          environment: "production",
          destination_domain: null,
          target_id: null,
          field_fingerprint: null,
          template_id: null,
          template_params: {
            output_path: outputPath,
            refs: parsed.refs.join(","),
          },
          allowed_domains: [],
        };
        const grants = await requireApprovals({
          store: services.approvals,
          bindings: [binding],
          daemonPort: daemonPortRef(),
          sessionStore: services.sessionStore,
          openUrlImpl: makeHubOpenUrlImpl(services, daemonPortRef),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(approvalIds !== undefined ? { approvalIdsFromClient: approvalIds } : {}),
          ...(waitForApproval === false ? { waitMs: 0 } : {}),
        });
        grant = grants[0];
      }

      if (outputPath === "-") {
        // Stdout-passthrough mode — return content in response body.
        // Burst 7 §2 (5q): resolve plaintext only now (after the gate), build the
        // values map + render immediately before the return.
        resolved = await services.vault.resolveRefs(parsed.refs);
        const valuesMap = new Map<string, string>();
        for (const [ref, r] of resolved) valuesMap.set(ref, r.value.bytes().toString("utf8"));
        const rendered = parsed.render(valuesMap);
        // Burst 7 §2 (5q): the SecretValue bytes are now baked into `rendered`
        // (the intentional plaintext-out wire surface, §0). Dispose the resolved
        // values and drop the per-value `valuesMap` strings IMMEDIATELY — before
        // the post-render markUsed() awaits — so no live SecretValue / extra
        // per-value string is held across that filesystem/audit work. The
        // finally is the idempotent backstop. `rendered` itself must survive to
        // the return (it IS the response body).
        for (const r of resolved.values()) r.value.dispose();
        resolved = undefined;
        valuesMap.clear();
        // All resolve/policy/approval checks have passed; plaintext is about to
        // leave the daemon in the response body, so flip the exposure flag now.
        auditOk = true;
        valueVisibleToAgent = true;
        for (const ref of parsed.refs) {
          await services.vault.markUsed(ref).catch(() => undefined);
        }
        return { rendered: true, refs_count: parsed.refs.length, content: rendered };
      }

      // File mode: must be absolute. CLI sends path.resolve()'d value.
      if (!path.isAbsolute(outputPath)) {
        throw new ShuttleError(
          "inject_output_path_unsafe",
          `output_path must be absolute: ${outputPath}`,
        );
      }

      // ---------------------------------------------------------------------
      // Path-safety walk. The dangerous case we defend against:
      //
      //   $HOME/escape  →  symlink to /tmp/outside/
      //   user passes -o $HOME/escape/file.yml
      //
      // A naive `mkdir(parent, { recursive: true })` followed by realpath()
      // would happily traverse the symlink and create /tmp/outside/, only
      // THEN rejecting based on realpath — too late. Instead:
      //   1. Find the deepest EXISTING ancestor of the parent dir.
      //      Along the way, lstat each existing path component and refuse
      //      if any is a symlink or non-directory.
      //   2. realpath the deepest existing ancestor; verify inside $HOME.
      //   3. mkdir the missing ancestors step-by-step (NOT recursive),
      //      shallowest first. Because we walked the existing prefix
      //      symlink-free AND each new mkdir creates a fresh directory,
      //      we cannot follow a symlink outside $HOME.
      // ---------------------------------------------------------------------
      const realHome = await realpath(os.homedir());
      const parentDir = path.dirname(outputPath);
      const missingStack: string[] = []; // deepest -> shallowest as we walk up
      let existing = parentDir;
      while (true) {
        try {
          const st = await lstat(existing);
          if (st.isSymbolicLink()) {
            throw new ShuttleError(
              "inject_output_path_unsafe",
              `Refusing — ancestor ${existing} is a symlink`,
            );
          }
          if (!st.isDirectory()) {
            throw new ShuttleError(
              "inject_output_path_unsafe",
              `Refusing — ancestor ${existing} is not a directory`,
            );
          }
          break; // deepest existing ancestor found
        } catch (e) {
          // ShuttleError thrown above is our own — let it propagate.
          if (e instanceof ShuttleError) throw e;
          const err = e as NodeJS.ErrnoException;
          if (err.code !== "ENOENT") throw e;
          missingStack.push(existing);
          const next = path.dirname(existing);
          if (next === existing) {
            // Walked off the root without finding ANY existing prefix.
            throw new ShuttleError(
              "inject_output_path_unsafe",
              `Refusing — no existing ancestor for ${outputPath}`,
            );
          }
          existing = next;
        }
      }
      const realExisting = await realpath(existing);
      const rel = path.relative(realHome, realExisting);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new ShuttleError(
          "inject_output_path_unsafe",
          `Refusing to write outside HOME (ancestor realpath ${realExisting} not inside ${realHome})`,
        );
      }
      // Create the missing ancestors shallowest-first, one at a time. After
      // each mkdir, immediately lstat the just-created path to confirm it's
      // a real directory — defends against a concurrent attacker who races
      // to swap in a symlink between our mkdir call and the next iteration.
      // Each newly-created dir is at 0o700 so an unprivileged attacker on
      // the same machine couldn't write into it during the window, but a
      // process running as the same UID still could; the post-mkdir lstat
      // closes that gap.
      while (missingStack.length > 0) {
        const next = missingStack.pop()!;
        await mkdir(next, { mode: 0o700 });
        const st = await lstat(next);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          throw new ShuttleError(
            "inject_output_path_unsafe",
            `Refusing — ${next} was swapped after mkdir (now ${st.isSymbolicLink() ? "a symlink" : "not a directory"})`,
          );
        }
      }

      // Leaf-symlink check: if the target already exists AND is a symlink, refuse.
      try {
        const st = await lstat(outputPath);
        if (st.isSymbolicLink()) {
          throw new ShuttleError(
            "inject_output_path_unsafe",
            `Refusing to write through a symlink: ${outputPath}`,
          );
        }
      } catch (e) {
        if (e instanceof ShuttleError) throw e;
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        // ENOENT — file doesn't exist yet — fine, proceed.
      }

      // Final TOCTOU guard: between the ancestor walk and now, a same-UID
      // process could have replaced the parent dir with a symlink. Re-realpath
      // the parent and re-verify it's inside realHome IMMEDIATELY before the
      // temp-file open. The O_EXCL open below also defends against a swapped-in
      // leaf, but it can't catch a swapped-in parent.
      const parentDirForWrite = path.dirname(outputPath);
      const realParentFinal = await realpath(parentDirForWrite);
      const relFinal = path.relative(realHome, realParentFinal);
      if (relFinal.startsWith("..") || path.isAbsolute(relFinal)) {
        throw new ShuttleError(
          "inject_output_path_unsafe",
          `Refusing — parent path ${parentDirForWrite} now resolves outside HOME (${realParentFinal})`,
        );
      }

      // Atomic write: temp file with O_EXCL + 0600, then rename. We use the
      // ORIGINAL outputPath (now confirmed safe through the final realpath
      // check above) so the user-visible final path matches what they passed.
      const finalPath = outputPath;
      const tempPath = `${finalPath}.${randomBytes(8).toString("hex")}.tmp`;
      let fh: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // Burst 7 §2 (5q): open the temp fh FIRST (it's part of the file-mode
        // setup that must complete before rendering, spec line 234). Then
        // resolve + build values + render + writeFile back-to-back with NO await
        // (filesystem or otherwise) between render and write, so the rendered
        // plaintext string exists only from parsed.render(...) to the
        // immediately-following writeFile and is never held across I/O. The
        // resolveRefs await BELOW produces the bytes (the resolve boundary) — it
        // holds no rendered string.
        fh = await open(tempPath, "wx", 0o600);
        resolved = await services.vault.resolveRefs(parsed.refs);
        const valuesMap = new Map<string, string>();
        for (const [ref, r] of resolved) valuesMap.set(ref, r.value.bytes().toString("utf8"));
        let rendered: string | undefined = parsed.render(valuesMap);
        await fh.writeFile(rendered, "utf8");
        // Burst 7 §2 (5q): the rendered plaintext is now materialized at the
        // sink (the 0600 file) and never returned in file mode. Dispose the
        // resolved SecretValues and DROP the rendered string + per-value
        // `valuesMap` strings RIGHT AFTER the write resolves — before the
        // fh.close()/rename() awaits and the post-write markUsed()/audit work —
        // so neither a live SecretValue nor the rendered/per-value plaintext
        // strings are held across that filesystem/audit latency (spec lines
        // 234/285). Nulling `rendered` makes it GC-eligible immediately rather
        // than reachable until the inner try scope ends. The route's finally is
        // the idempotent backstop for the throw/timeout paths.
        for (const r of resolved.values()) r.value.dispose();
        resolved = undefined;
        valuesMap.clear();
        rendered = undefined;
        await fh.close();
        fh = undefined;
        await rename(tempPath, finalPath);
      } catch (e) {
        if (fh !== undefined) await fh.close().catch(() => undefined);
        await rm(tempPath, { force: true }).catch(() => undefined);
        if (e instanceof ShuttleError) throw e;
        throw new ShuttleError(
          "inject_output_write_failed",
          e instanceof Error ? e.message : String(e),
        );
      }

      auditOk = true;
      for (const ref of parsed.refs) {
        await services.vault.markUsed(ref).catch(() => undefined);
      }
      return { rendered: true, output_path: finalPath, refs_count: parsed.refs.length };
    } catch (e) {
      auditErrorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
      throw e;
    } finally {
      // Burst 7 §2 (5q): dispose every resolved SecretValue on EVERY exit path
      // (success, throw, timeout). Idempotent + no-op when `resolved` is
      // undefined (a throw before the plaintext resolve, e.g. path-unsafe).
      for (const r of resolved?.values() ?? []) r.value.dispose();
      // Per-ref audit (success or failure). When the metadata preflight threw,
      // `metaByRef` is undefined and we audit per-requested-ref without
      // environment info — a denied/non-existent ref is still security-relevant.
      for (const ref of parsed.refs) {
        const record = metaByRef?.get(ref);
        await writeDaemonAudit({
          action: "inject_render",
          ok: auditOk,
          ref,
          value_visible_to_agent: valueVisibleToAgent,
          ...(record !== undefined ? { environment: record.environment } : {}),
          ...(auditErrorCode !== undefined ? { error_code: auditErrorCode } : {}),
          // For inject_render this conditional spread always evaluates to
          // nothing: the action is not a SessionAction, the matcher refuses,
          // requireApproval falls back to single-use, and grant.session_id is
          // undefined. We still write the spread so the audit-shape contract
          // matches the session-capable routes.
          ...(grant?.session_id !== undefined ? { session_id: grant.session_id } : {}),
        });
      }
    }
  });
}
