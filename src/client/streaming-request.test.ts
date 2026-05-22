import { test } from "node:test";
import assert from "node:assert/strict";
import { streamLineDelimitedJson, type StreamLine } from "./streaming-request.js";

/** Helper: construct a fake ReadableStream<Uint8Array> from string chunks. */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i++;
    },
  });
}

test("streamLineDelimitedJson: invokes onLine for each newline-terminated JSON line", async () => {
  const stream = makeStream([
    `{"stream":"stdout","data":"aGVsbG8="}\n`,
    `{"stream":"stderr","data":"d29ybGQ="}\n`,
    `{"exit":0}\n`,
  ]);
  const lines: StreamLine[] = [];
  await streamLineDelimitedJson(stream, (l) => { lines.push(l); });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { stream: "stdout", data: "aGVsbG8=" });
  assert.deepEqual(lines[2], { exit: 0 });
});

test("streamLineDelimitedJson: handles lines split across chunk boundaries", async () => {
  const stream = makeStream([
    `{"stream":"stdout","da`,
    `ta":"aGVsbG8="}\n{"exit":0}\n`,
  ]);
  const lines: StreamLine[] = [];
  await streamLineDelimitedJson(stream, (l) => { lines.push(l); });
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.data, "aGVsbG8=");
});

test("streamLineDelimitedJson: skips empty lines (between messages)", async () => {
  const stream = makeStream([`{"exit":0}\n\n\n`]);
  const lines: StreamLine[] = [];
  await streamLineDelimitedJson(stream, (l) => { lines.push(l); });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { exit: 0 });
});

test("streamLineDelimitedJson: invalid JSON throws", async () => {
  const stream = makeStream([`not valid json\n`]);
  await assert.rejects(
    () => streamLineDelimitedJson(stream, () => undefined),
    (err) => err instanceof Error && /invalid JSON/i.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// streamingDaemonRequest contract — exercises the live HTTP path against a
// throwaway daemon. Lives in this file because the helper is small enough
// and the test doubles as documentation for the error-preservation contract
// from Plan 1 (daemon-provided hint + exit_code MUST survive non-200 paths).
// ---------------------------------------------------------------------------

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ShuttleError } from "../shared/errors.js";
import { DaemonServer } from "../daemon/server.js";
import { writeSocketFile } from "../daemon/socket-file.js";
import { streamingDaemonRequest } from "./streaming-request.js";

/**
 * Same isolation pattern as withEphemeralDaemon in daemon-client.test.ts:
 * point SECRET_SHUTTLE_HOME at a fresh tmpdir so the test never writes to
 * the user's real ~/.secret-shuttle/daemon-socket.json. Without this, a
 * concurrent live daemon would have its socket file clobbered every time
 * this test runs.
 */
async function withEphemeralStreamingDaemon<T>(
  setup: (server: DaemonServer) => void,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-stream-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  const token = "test-token-streaming";
  const server = new DaemonServer({ token });
  setup(server);
  const { port } = await server.listen(0);
  await writeSocketFile({ port, token, pid: process.pid });
  try {
    return await fn(token);
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("streamingDaemonRequest: preserves daemon-provided hint and exit_code on non-200", async () => {
  await withEphemeralStreamingDaemon(
    (server) => {
      server.addRouteStreaming("POST", "/v1/run/resolve", async (_req, _body, res) => {
        // Emit a structured-error payload with BOTH nested + flat fields,
        // plus a hint and a custom exit_code — the canonical Plan-1 shape.
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: false,
          error: { code: "secret_not_found", message: "ref missing" },
          error_code: "secret_not_found",
          message: "ref missing",
          hint: "secret-shuttle secrets list",
          exit_code: 3,
        }));
      });
    },
    async () => {
      const err = await streamingDaemonRequest("POST", "/v1/run/resolve", { refs: ["ss://x/dev/A"] })
        .then(() => null, (e: unknown) => e);
      assert.ok(err instanceof ShuttleError);
      assert.equal(err.code, "secret_not_found");
      assert.equal(err.hint, "secret-shuttle secrets list", "hint MUST be preserved from the daemon");
      assert.equal(err.exitCode, 3, "exit_code MUST be preserved from the daemon");
    },
  );
});
