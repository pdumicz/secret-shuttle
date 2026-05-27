import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnAndStream, type OutputWriter } from "./spawner.js";

class CollectingWriter implements OutputWriter {
  stdoutChunks: Buffer[] = [];
  stderrChunks: Buffer[] = [];
  exitCode: number | null = null;
  errors: Array<{ code: string; message: string; exit_code?: number }> = [];

  writeStdout(chunk: Buffer): void {
    this.stdoutChunks.push(chunk);
  }
  writeStderr(chunk: Buffer): void {
    this.stderrChunks.push(chunk);
  }
  writeExit(code: number): void {
    this.exitCode = code;
  }
  writeError(err: { code: string; message: string; exit_code?: number }): void {
    this.errors.push(err);
  }
  stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }
  stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }
}

/**
 * Minimal writer used by the stdin-pass-through tests below. Exposes raw
 * Buffer arrays (so tests can use `Buffer.concat(writer.stdout)`) and a
 * plain `exit` number, matching the Task C plan's test shape.
 */
interface TestWriter extends OutputWriter {
  stdout: Buffer[];
  stderr: Buffer[];
  exit: number | null;
  errors: Array<{ code: string; message: string; exit_code?: number }>;
}

function makeTestWriter(): TestWriter {
  const w: TestWriter = {
    stdout: [],
    stderr: [],
    exit: null,
    errors: [],
    writeStdout(chunk: Buffer): void {
      w.stdout.push(chunk);
    },
    writeStderr(chunk: Buffer): void {
      w.stderr.push(chunk);
    },
    writeExit(code: number): void {
      w.exit = code;
    },
    writeError(err: { code: string; message: string; exit_code?: number }): void {
      w.errors.push(err);
    },
  };
  return w;
}

test("spawnAndStream: captures stdout from `node -e \"console.log('hi')\"`", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.log('hi')"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdout(), "hi\n");
  assert.equal(w.errors.length, 0);
});

test("spawnAndStream: captures stderr separately", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.error('oops')"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stderr(), "oops\n");
});

test("spawnAndStream: forwards non-zero exit codes", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "process.exit(42)"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 42);
});

test("spawnAndStream: missing binary writes spawn_failed error + exit 127 (both error.exit_code and writeExit)", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: "/totally/nonexistent/binary",
    args: [],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 127);
  assert.equal(w.errors.length, 1);
  assert.equal(w.errors[0]!.code, "spawn_failed");
  // The error itself must carry exit_code 127 so the CLI overrides the
  // spawn_failed registry default (TRANSIENT=1) and exits with the POSIX
  // command-not-found convention.
  assert.equal(w.errors[0]!.exit_code, 127, "writeError must include exit_code: 127");
});

test("spawnAndStream: env vars are injected verbatim (shell:false; no expansion)", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "console.log(process.env.HELLO)"],
    env: { HELLO: "world", PATH: process.env.PATH ?? "" },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdout().trim(), "world");
});

test("spawnAndStream: cwd is honored — child observes the supplied cwd", async () => {
  const w = new CollectingWriter();
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), "spawner-cwd-"));
  try {
    await spawnAndStream({
      cmd: process.execPath,
      args: ["-e", "console.log(process.cwd())"],
      env: { ...process.env },
      cwd: tmpdir,
      outputWriter: w,
    });
    assert.equal(w.exitCode, 0);
    // macOS resolves /var → /private/var; compare via realpath.
    const { realpath } = await import("node:fs/promises");
    const expected = await realpath(tmpdir);
    const got = await realpath(w.stdout().trim());
    assert.equal(got, expected);
  } finally {
    await rm(tmpdir, { recursive: true, force: true });
  }
});

test("spawnAndStream: AbortSignal SIGTERMs a long-running child", async () => {
  const w = new CollectingWriter();
  const controller = new AbortController();
  // Schedule the abort almost immediately. The child sleeps 30s — without
  // cancellation the test would time out.
  setTimeout(() => controller.abort(), 50);
  const start = Date.now();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 30000); console.log('alive')"],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
    signal: controller.signal,
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10_000, `child should have been killed quickly; took ${elapsed}ms`);
  // Exit code: SIGTERM → 143 on POSIX (128 + 15). Windows may differ.
  assert.notEqual(w.exitCode, 0, "child should NOT exit cleanly when SIGTERMed");
});

test("spawnAndStream: stdin is closed (Plan 3 scope) — child sees EOF on read", async () => {
  const w = new CollectingWriter();
  await spawnAndStream({
    cmd: process.execPath,
    args: ["-e", `
      let bytes = 0;
      process.stdin.on('data', (d) => { bytes += d.length; });
      process.stdin.on('end', () => { console.log('eof', bytes); process.exit(0); });
    `],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: w,
  });
  assert.equal(w.exitCode, 0);
  assert.equal(w.stdout().trim(), "eof 0");
});

test("spawnAndStream: stdinBytes undefined → child sees EOF on stdin", async () => {
  const writer = makeTestWriter();
  // `cat` exits when stdin closes. With stdio[0]="ignore", child reads EOF immediately.
  await spawnAndStream({
    cmd: "cat",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
  });
  assert.equal(writer.exit, 0);
  assert.equal(Buffer.concat(writer.stdout).toString(), "");
});

test("spawnAndStream: stdinBytes provided → child reads exactly those bytes + EOF", async () => {
  const writer = makeTestWriter();
  const payload = Buffer.from("hello-stdin-12345");
  await spawnAndStream({
    cmd: "cat",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });
  assert.equal(writer.exit, 0);
  assert.equal(Buffer.concat(writer.stdout).toString(), "hello-stdin-12345");
});

test("spawnAndStream: stdinBytes empty Buffer → child reads EOF immediately", async () => {
  const writer = makeTestWriter();
  await spawnAndStream({
    cmd: "cat",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: Buffer.alloc(0),
  });
  assert.equal(writer.exit, 0);
  assert.equal(Buffer.concat(writer.stdout).toString(), "");
});

test("spawnAndStream: child that ignores stdin and exits early still completes (EPIPE swallowed)", async () => {
  const writer = makeTestWriter();
  // `true` is a POSIX no-op that exits 0 immediately without reading stdin.
  // If our stdin write produces an unhandled EPIPE, this test would fail
  // with an uncaught exception.
  const payload = Buffer.from("never-read");
  await spawnAndStream({
    cmd: "true",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });
  assert.equal(writer.exit, 0);
});

// Memory hygiene (parity with templates/run B3 — commit b9421d1): the
// stdinBytes Buffer typically holds a resolved-from-vault secret, so we
// must zero it after the child reads it (or after the pipe tears down).
// Scrubbing BEFORE the write callback risks clobbering not-yet-flushed
// bytes, so the .end(buf, cb) callback is the PRIMARY trigger. error/close
// listeners are fallbacks for abnormal termination.

test("spawnAndStream stdin scrub: stdinBytes Buffer is zeroed AFTER the write callback fires (normal path)", async () => {
  const writer = makeTestWriter();
  const secretText = "needle-spawner-7c2e-do-not-leak";
  const payload = Buffer.from(secretText, "utf8");
  // Sanity: payload starts as the secret bytes.
  assert.equal(payload.toString("utf8"), secretText);

  // Child reads stdin and exits 0 — exercises the happy path (normal close).
  // Using `cat` (or node script) round-trips the bytes so we can also confirm
  // the child saw them BEFORE we scrubbed.
  await spawnAndStream({
    cmd: process.execPath,
    args: [
      "-e",
      "process.stdin.on('data',(d)=>process.stdout.write(d)).on('end',()=>process.exit(0))",
    ],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });

  assert.equal(writer.exit, 0);
  // The child echoed our bytes to stdout — proof the bytes flushed BEFORE
  // the scrub fired (otherwise the child would have seen zeros).
  assert.equal(Buffer.concat(writer.stdout).toString("utf8"), secretText);
  // Now the local Buffer must be all zeros — the .end(buf, cb) callback
  // fired before the promise resolved.
  assert.equal(payload.length, Buffer.byteLength(secretText, "utf8"));
  for (let i = 0; i < payload.length; i++) {
    assert.equal(payload[i], 0, `byte ${i} should be zero but is ${payload[i]}`);
  }
  // Sanity: the original plaintext must not be recoverable from the buffer.
  assert.equal(payload.includes(Buffer.from(secretText, "utf8")), false);
});

test("spawnAndStream stdin scrub: stdinBytes is scrubbed on EPIPE (child closes stdin early)", async () => {
  const writer = makeTestWriter();
  const secretText = "needle-spawner-epipe-9a3b-do-not-leak";
  const payload = Buffer.from(secretText, "utf8");

  // `true` exits 0 immediately without reading stdin. The daemon's write
  // produces EPIPE, which is swallowed by the on('error') handler — and our
  // EPIPE branch must scrub the Buffer immediately rather than waiting for
  // an end-callback that may never fire.
  await spawnAndStream({
    cmd: "true",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });

  assert.equal(writer.exit, 0);
  // Whether the scrub fires from the EPIPE branch, the 'close' fallback, or
  // the end-callback, the contract is: by the time the promise resolves, the
  // Buffer is zeroed.
  for (let i = 0; i < payload.length; i++) {
    assert.equal(
      payload[i],
      0,
      `byte ${i} should be zero on EPIPE path but is ${payload[i]}`,
    );
  }
  assert.equal(payload.includes(Buffer.from(secretText, "utf8")), false);
});

test("spawnAndStream stdin scrub: sync spawn() failure (null byte in cmd) still scrubs stdinBytes", async () => {
  // Reproducer for a P2 edge case: when spawn() throws synchronously (e.g.
  // TypeError "must not contain null bytes" from an argv with a NUL), the
  // catch block previously wrote spawn_failed + resolved without scrubbing.
  // The child never existed, so the regular .end(buf, cb) path never
  // installed — the Buffer leaked plaintext until GC.
  const writer = makeTestWriter();
  const secretText = "needle-spawner-sync-throw-do-not-leak";
  const payload = Buffer.from(secretText, "utf8");
  // Sanity: payload starts as the secret bytes.
  assert.equal(payload.toString("utf8"), secretText);

  await spawnAndStream({
    // Null byte in argv triggers a synchronous TypeError from Node's
    // spawn(): "The argument 'file' must be a string without null bytes."
    cmd: "bad\0cmd",
    args: [],
    env: { ...process.env },
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });

  // Preserved behavior: spawn_failed + exit 127.
  assert.equal(writer.exit, 127);
  assert.equal(writer.errors.length, 1);
  assert.equal(writer.errors[0]!.code, "spawn_failed");
  assert.equal(writer.errors[0]!.exit_code, 127);

  // New behavior under test: the Buffer must be zeroed.
  for (let i = 0; i < payload.length; i++) {
    assert.equal(
      payload[i],
      0,
      `byte ${i} should be zero on sync-throw path but is ${payload[i]}`,
    );
  }
  assert.equal(payload.includes(Buffer.from(secretText, "utf8")), false);
});

// Note: a unit test for the `c.stdin === null` defensive branch is
// intentionally skipped. With the current spawnAndStream implementation,
// stdio[0] is always set to "pipe" when stdinBytes is defined, so
// c.stdin === null is unreachable without dependency-injecting a stubbed
// child_process.spawn — which would require a substantial test harness
// change (the spawner imports `spawn` directly). The defensive branch is
// guarded by a code comment and exists solely to harden against future
// refactors. Coverage relies on code review.

test("spawnAndStream stdin scrub: empty stdinBytes Buffer still completes without throwing", async () => {
  // Edge case: a zero-length Buffer. fill(0) is a no-op on len=0; the boolean
  // guard still sets scrubbed=true so multi-fire is safe. Verifies the scrub
  // path doesn't choke on empty payloads.
  const writer = makeTestWriter();
  const payload = Buffer.alloc(0);
  await spawnAndStream({
    cmd: "cat",
    args: [],
    env: process.env,
    cwd: process.cwd(),
    outputWriter: writer,
    stdinBytes: payload,
  });
  assert.equal(writer.exit, 0);
  // Length is still 0; fill(0) on len=0 is a no-op; no assertion needed on
  // content beyond "didn't throw".
  assert.equal(payload.length, 0);
});
