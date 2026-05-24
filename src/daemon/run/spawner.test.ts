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
