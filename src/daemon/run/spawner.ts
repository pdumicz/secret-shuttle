import { spawn } from "node:child_process";

export interface OutputWriter {
  writeStdout(chunk: Buffer): void;
  writeStderr(chunk: Buffer): void;
  writeExit(code: number): void;
  /**
   * Surface a structured daemon-side error mid-stream. `exit_code` is optional;
   * when present, it OVERRIDES the registry default on the CLI side via
   * daemonErrorFromPayload. This matters for spawn_failed: the registry default
   * is 1 (TRANSIENT), but POSIX convention for "command not found" is 127 —
   * we want `secret-shuttle run -- missing-binary` to exit 127 like
   * `op run` / `doppler run`.
   */
  writeError(err: { code: string; message: string; exit_code?: number }): void;
}

export interface SpawnInput {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * Absolute path. The route is responsible for validating this is absolute
   * and rejecting requests where the CLI didn't send one — spawnAndStream
   * does not silently fall back to the daemon's process.cwd().
   */
  cwd: string;
  outputWriter: OutputWriter;
  /**
   * Optional. If signaled, the child is SIGTERMed; if still alive after 5s,
   * SIGKILLed. Used by the route to kill the child when the HTTP response is
   * closed by the CLI (Ctrl-C, socket disconnect).
   */
  signal?: AbortSignal;
  /**
   * Optional bytes to write to the child's stdin. When set:
   *  - The child is spawned with stdio[0] = "pipe" (instead of "ignore").
   *  - The daemon writes the bytes synchronously, then calls .end() to
   *    flush + send EOF.
   *  - EPIPE (child closed stdin before reading) is swallowed; the
   *    promise still resolves on child exit. The route-layer audit
   *    can be extended to record stdin_write_failed if needed.
   * The CLI never sees these bytes; only the daemon process holds them.
   */
  stdinBytes?: Buffer;
}

const KILL_GRACE_MS = 5_000;

/**
 * Spawn a child process with shell:false + the supplied env, and stream
 * stdout/stderr/exit through the OutputWriter. Resolves once the child exits
 * AND all output has been forwarded.
 *
 * Spawn errors (binary not found, permission denied) are surfaced via
 * outputWriter.writeError + writeExit(127). This function does NOT throw.
 *
 * stdin: when `input.stdinBytes` is set, the daemon writes those bytes to the
 * child's fd 0 and closes the stream; otherwise the child sees EOF immediately
 * (fd 0 → /dev/null).
 *
 * Cancellation: if `signal` fires, SIGTERM is sent immediately; if the child
 * is still alive after KILL_GRACE_MS, SIGKILL.
 */
export function spawnAndStream(input: SpawnInput): Promise<void> {
  return new Promise<void>((resolve) => {
    let exited = false;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(input.cmd, input.args, {
        shell: false,
        env: input.env,
        cwd: input.cwd,
        stdio: input.stdinBytes !== undefined
          ? ["pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      input.outputWriter.writeError({
        code: "spawn_failed",
        message: e instanceof Error ? e.message : String(e),
        exit_code: 127, // POSIX convention for "command not found" / "command cannot execute"
      });
      input.outputWriter.writeExit(127);
      resolve();
      return;
    }

    const c = child;

    // Cancellation wiring: SIGTERM on abort, SIGKILL after grace.
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (exited || c.killed) return;
      c.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) c.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    c.stdout?.on("data", (chunk: Buffer) => input.outputWriter.writeStdout(chunk));
    c.stderr?.on("data", (chunk: Buffer) => input.outputWriter.writeStderr(chunk));

    // If stdin bytes were supplied, write+end the stream. EPIPE is
    // swallowed: a child that ignores stdin (or exits before reading)
    // produces this signal, but we don't want to crash the spawn for
    // it — the child still runs to completion.
    if (input.stdinBytes !== undefined && c.stdin !== null) {
      c.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE") return;
        // Non-EPIPE errors should still bubble through writeError but
        // not crash the daemon. Log via outputWriter so the route can
        // surface as a structured stream event.
        input.outputWriter.writeError({
          code: "stdin_write_failed",
          message: err.message,
        });
      });
      c.stdin.write(input.stdinBytes);
      c.stdin.end();
    }

    c.on("error", (err: Error) => {
      if (exited) return;
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      input.outputWriter.writeError({ code: "spawn_failed", message: err.message, exit_code: 127 });
      input.outputWriter.writeExit(127);
      resolve();
    });
    c.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      // POSIX convention: signal → 128 + signum. Approximate for common signals.
      const exitCode = code !== null ? code : signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 1;
      input.outputWriter.writeExit(exitCode);
      resolve();
    });
  });
}
