import { mkdir, lstat, realpath, rename, rm, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { ShuttleError } from "../../../shared/errors.js";
import { requireApproval } from "../../approvals/require-approval.js";
import type { ApprovalBinding } from "../../approvals/store.js";
import type { DaemonServer } from "../../server.js";
import type { DaemonServices } from "../../services.js";
import { parseTemplate } from "../../inject/template.js";
import { assertSecretActionAllowed } from "../../../policy/policy.js";
import { writeDaemonAudit } from "../../audit.js";
import { asObject, optBool, optString, reqString } from "../validate.js";

export function registerInjectRenderRoute(
  server: DaemonServer,
  services: DaemonServices,
  daemonPortRef: () => number,
): void {
  server.addRoute("POST", "/v1/inject/render", async (_req, raw) => {
    services.lock.requireKey();

    const o = asObject(raw);
    const template = reqString(o, "template");
    const outputPath = reqString(o, "output_path");
    const approvalId = optString(o, "approval_id");
    const waitForApproval = optBool(o, "wait_for_approval");

    const parsed = parseTemplate(template);

    // Per-ref audit at the END must always fire — declare these outside the try
    // so the finally block sees them. `resolved` may still be undefined if the
    // resolveRefs() throw fires (deleted ref → secret_not_found); the finally
    // block tolerates that.
    let resolved: Awaited<ReturnType<typeof services.vault.resolveRefs>> | undefined;
    let auditOk = false;
    let auditErrorCode: string | undefined;

    try {
      resolved = await services.vault.resolveRefs(parsed.refs);
      // Enforce policy per ref BEFORE the approval gate — fail closed without
      // prompting if any opted-out of use_as_stdin.
      for (const record of resolved.values()) {
        assertSecretActionAllowed(record, "use_as_stdin");
      }

      const isProduction = Array.from(resolved.values()).some(
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
        await requireApproval({
          store: services.approvals,
          binding,
          daemonPort: daemonPortRef(),
          ...(approvalId !== undefined ? { approvalIdFromClient: approvalId } : {}),
          ...(waitForApproval === false ? { waitMs: 0 } : {}),
        });
      }

      const valuesMap = new Map<string, string>();
      for (const [ref, record] of resolved) {
        valuesMap.set(ref, record.value);
      }
      const rendered = parsed.render(valuesMap);

      if (outputPath === "-") {
        // Stdout-passthrough mode — return content in response body.
        auditOk = true;
        for (const ref of resolved.keys()) {
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
        fh = await open(tempPath, "wx", 0o600);
        await fh.writeFile(rendered, "utf8");
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
      for (const ref of resolved.keys()) {
        await services.vault.markUsed(ref).catch(() => undefined);
      }
      return { rendered: true, output_path: finalPath, refs_count: parsed.refs.length };
    } catch (e) {
      auditErrorCode = e instanceof ShuttleError ? e.code : "unexpected_error";
      throw e;
    } finally {
      // Per-ref audit (success or failure). When resolveRefs() threw,
      // `resolved` is undefined and we audit per-requested-ref without
      // environment info — a denied/non-existent ref is still security-relevant.
      for (const ref of parsed.refs) {
        const record = resolved?.get(ref);
        await writeDaemonAudit({
          action: "inject_render",
          ok: auditOk,
          ref,
          ...(record !== undefined ? { environment: record.environment } : {}),
          ...(auditErrorCode !== undefined ? { error_code: auditErrorCode } : {}),
        });
      }
    }
  });
}
