import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonServer } from "../../server.js";
import { DaemonServices } from "../../services.js";
import { registerRoutes } from "../router.js";
import type { StreamLine } from "../../../client/streaming-request.js";

interface Ctx {
  port: number;
  token: string;
  services: DaemonServices;
  home: string;
}

async function withDaemon<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-runres-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  const prevSecure = process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
  process.env.SECRET_SHUTTLE_HOME = home;
  process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = "1";
  const server = new DaemonServer({ token: "t" });
  const services = new DaemonServices();
  let port = 0;
  registerRoutes(server, services, () => port);
  ({ port } = await server.listen(0));
  try {
    return await fn({ port, token: "t", services, home });
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    if (prevSecure === undefined) delete process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE;
    else process.env.SECRET_SHUTTLE_INSECURE_DEV_MODE = prevSecure;
    await rm(home, { recursive: true, force: true });
  }
}

/** Plain JSON call for unlock/seed/etc. — same shape as secrets-delete.test.ts. */
async function call(
  ctx: Pick<Ctx, "port" | "token">,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * Streaming call. Returns:
 *   - `status`: HTTP status code
 *   - `contentType`: response content-type header
 *   - `lines`: parsed StreamLine[] (only populated when content-type is ndjson)
 *   - `errorBody`: parsed JSON body when status !== 200 (pre-stream error path)
 *   - `stdout` / `stderr`: utf-8 string aggregations of decoded chunks
 */
async function callStream(
  ctx: Pick<Ctx, "port" | "token">,
  p: string,
  body: unknown,
  options?: { signal?: AbortSignal },
): Promise<{
  status: number;
  contentType: string;
  lines: StreamLine[];
  errorBody?: Record<string, unknown>;
  stdout: string;
  stderr: string;
}> {
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  };
  const res = await fetch(`http://127.0.0.1:${ctx.port}${p}`, init);
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status !== 200 || !contentType.includes("ndjson")) {
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { _raw: text };
    }
    return { status: res.status, contentType, lines: [], errorBody: parsed, stdout: "", stderr: "" };
  }
  const lines: StreamLine[] = [];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (raw.trim().length === 0) continue;
      const parsed = JSON.parse(raw) as StreamLine;
      lines.push(parsed);
      if ("stream" in parsed) {
        const buf = Buffer.from(parsed.data, "base64");
        if (parsed.stream === "stdout") stdoutChunks.push(buf);
        else stderrChunks.push(buf);
      }
    }
  }
  return {
    status: res.status,
    contentType,
    lines,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

/** Seed a development secret by directly seeding via the vault for tests that
 * need a known plaintext (the public CLI surface is generate-only). */
async function seedSecret(
  services: DaemonServices,
  opts: {
    source: string;
    environment: string;
    name: string;
    value: string;
    allowedActions?: string[];
  },
): Promise<string> {
  const result = await services.vault.upsertSecret({
    source: opts.source,
    environment: opts.environment,
    name: opts.name,
    value: opts.value,
    allowedDomains: [],
    ...(opts.allowedActions !== undefined ? { allowedActions: opts.allowedActions as never } : {}),
  });
  return result.ref;
}

// -----------------------------------------------------------------------------
// Happy-path streaming
// -----------------------------------------------------------------------------

test("POST /v1/run/resolve: streams stdout + exit for a simple development-classed run", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "HELLO", value: "world",
    });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "HELLO", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.HELLO + '\\n')"],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 200);
    assert.ok(r.contentType.includes("ndjson"));
    // Masking is on by default — the raw value "world" must NOT appear.
    assert.equal(r.stdout.includes("world"), false, "raw secret leaked into stdout");
    assert.equal(r.stdout, "***\n");
    const exitLine = r.lines.find((l) => "exit" in l) as { exit: number } | undefined;
    assert.equal(exitLine?.exit, 0);
  });
});

test("POST /v1/run/resolve: non-ref env values pass through verbatim and are NOT masked", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [],
      env: [{ key: "PORT", value: "3000", isRef: false }],
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.PORT)"],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 200);
    assert.equal(r.stdout, "3000"); // verbatim — user-supplied non-refs aren't secrets
  });
});

// -----------------------------------------------------------------------------
// Approval gating
// -----------------------------------------------------------------------------

test("POST /v1/run/resolve: production refs require approval (pre-stream JSON 400)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "production", name: "SECRET", value: "leakable",
    });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "SECRET", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      wait_for_approval: false,
    });
    // Approval failure short-circuits before res.flushHeaders → status 400, content-type JSON.
    assert.equal(r.status, 400);
    assert.equal((r.errorBody as { error_code: string }).error_code, "approval_required");
    assert.equal((r.errorBody as { error: { code: string } }).error.code, "approval_required");
  });
});

test("POST /v1/run/resolve: session pass-through — audit lacks session_id; uses stays at 0", async () => {
  // run is NOT a SessionAction in Plan 4a — the matcher canonicalizes `run`
  // to null and refuses. The route still accepts session_id in the body
  // (CLI uniformity), threads it to requireApproval, but the call falls
  // back to the single-use flow. With wait_for_approval:false we surface
  // approval_required. The audit entry MUST NOT carry session_id, and the
  // session use-counter MUST stay at 0 — no session was minted.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "production", name: "PROD_SECRET", value: "v",
    });
    // The broadest legal session pattern still won't match the `run` binding
    // because canonicalAction(run) returns null. See session-matchers.ts.
    const sg = ctx.services.sessionStore.create({
      actions: ["template-run", "inject-submit", "reveal-capture", "secrets-set"],
      ref_glob: "",
      destination_domains: ["any.com"],
      template_ids: ["any"],
      allowed_actions: [
        "capture_from_page",
        "inject_into_field",
        "compare_fingerprint",
        "use_as_stdin",
        "inject_submit",
      ],
      ttl_ms: 60_000,
    });
    ctx.services.sessionStore.approve(sg.id);

    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "PROD_SECRET", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
      session_id: sg.id,
      wait_for_approval: false,
    });
    assert.equal(r.status, 400);
    assert.equal((r.errorBody as { error_code: string }).error_code, "approval_required");

    // The most-recent `run` audit line must NOT carry session_id.
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const entries = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "run" && e.ref === ref);
    assert.ok(entries.length > 0, "expected at least one run audit entry");
    for (const e of entries) {
      assert.equal(
        (e as { session_id?: string }).session_id,
        undefined,
        "pass-through: audit must NOT carry session_id (matcher refused → single-use fallback)",
      );
    }

    // Session was NOT minted — uses stays at 0.
    assert.equal(ctx.services.sessionStore.get(sg.id)!.uses, 0);
  });
});

// -----------------------------------------------------------------------------
// Error paths (pre-stream)
// -----------------------------------------------------------------------------

test("POST /v1/run/resolve: missing ref → secret_not_found error response (pre-stream)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: ["ss://x/dev/missing"],
      env: [],
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 400);
    assert.equal((r.errorBody as { error_code: string }).error_code, "secret_not_found");
  });
});

test("POST /v1/run/resolve: secret with use_as_stdin removed → action_not_allowed (pre-spawn)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "NO_STDIN", value: "x",
      allowedActions: ["inject_into_field"], // deliberately excludes use_as_stdin
    });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "NO_STDIN", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", "console.log('should-not-run')"],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 400);
    assert.equal((r.errorBody as { error_code: string }).error_code, "action_not_allowed");
    // Child must NOT have run.
    assert.equal(r.stdout, "");
  });
});

test("POST /v1/run/resolve: missing cwd → missing_param (pre-spawn)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [],
      env: [],
      command: process.execPath,
      args: ["-e", ""],
      // cwd intentionally omitted
    });
    assert.equal(r.status, 400);
    assert.equal((r.errorBody as { error_code: string }).error_code, "missing_param");
  });
});

test("POST /v1/run/resolve: relative cwd → missing_param (pre-spawn)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [],
      env: [],
      command: process.execPath,
      args: ["-e", ""],
      cwd: "./relative",
    });
    assert.equal(r.status, 400);
    assert.equal((r.errorBody as { error_code: string }).error_code, "missing_param");
  });
});

// -----------------------------------------------------------------------------
// Strict body validation
// -----------------------------------------------------------------------------

async function assertBadRequest(
  ctx: Pick<Ctx, "port" | "token">,
  body: Record<string, unknown>,
  desc: string,
): Promise<void> {
  const r = await callStream(ctx, "/v1/run/resolve", body);
  assert.equal(r.status, 400, `${desc}: expected 400`);
  assert.equal(
    (r.errorBody as { error_code: string }).error_code,
    "bad_request",
    `${desc}: expected error_code = bad_request`,
  );
}

test("POST /v1/run/resolve: strict body validation — refs must be an array", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await assertBadRequest(
      ctx,
      { refs: "not-an-array", env: [], command: process.execPath, args: [], cwd: process.cwd() },
      "refs string",
    );
  });
});

test("POST /v1/run/resolve: strict body validation — refs entries must be strings", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await assertBadRequest(
      ctx,
      { refs: ["ok", 123], env: [], command: process.execPath, args: [], cwd: process.cwd() },
      "refs non-string entry",
    );
  });
});

test("POST /v1/run/resolve: strict body validation — args must be an array of strings", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await assertBadRequest(
      ctx,
      { refs: [], env: [], command: process.execPath, args: [null, "x"], cwd: process.cwd() },
      "args non-string entry",
    );
  });
});

test("POST /v1/run/resolve: strict body validation — env entries must have key/value/isRef", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await assertBadRequest(
      ctx,
      { refs: [], env: [{ key: "X" }], command: process.execPath, args: [], cwd: process.cwd() },
      "env missing fields",
    );
  });
});

test("POST /v1/run/resolve: strict body validation — env entry value must be a string", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    await assertBadRequest(
      ctx,
      {
        refs: [],
        env: [{ key: "X", value: 42, isRef: false }],
        command: process.execPath,
        args: [],
        cwd: process.cwd(),
      },
      "env value non-string",
    );
  });
});

// -----------------------------------------------------------------------------
// Masking + cross-stream independence
// -----------------------------------------------------------------------------

test("POST /v1/run/resolve: resolved value never appears in the stream (masking guarantee)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const value = "THE_SECRET_VALUE_DO_NOT_LEAK";
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "HELLO", value,
    });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "HELLO", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.HELLO + ' ' + process.env.HELLO)"],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 200);
    assert.equal(r.stdout.includes(value), false, "raw value leaked");
    assert.ok(r.stdout.includes("***"), "mask token absent — masker did not run");
    assert.equal(r.stdout, "*** ***");
  });
});

test("POST /v1/run/resolve: stdout and stderr maskers are independent (no cross-stream leak)", async () => {
  // Regression for the "shared masker" bug. With a single shared masker, a
  // 3-byte stdout prefix held back across an intervening stderr chunk would
  // (incorrectly) reassemble across streams. Per-stream maskers fix this.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const value = "RUFOAUSX"; // 8 bytes; pick chars unlikely to appear in env/output
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "SPLIT", value,
    });
    // Child writes 'RUF' → stdout, 'OAUS' → stderr, 'X' → stdout.
    // No single stream contains the full secret; a shared masker would see
    // the bytes as one continuous stream and incorrectly mask the recombined
    // sequence into stderr (or the leftover into stdout at flush).
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "SECRET", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", `
        const s = process.env.SECRET;
        process.stdout.write(s.slice(0, 3));
        setImmediate(() => {
          process.stderr.write(s.slice(3, 7));
          setImmediate(() => { process.stdout.write(s.slice(7)); });
        });
      `],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 200);
    // Neither stream contains the full secret.
    assert.equal(r.stdout.includes(value), false, "shared-masker regression: stdout has full secret");
    assert.equal(r.stderr.includes(value), false, "shared-masker regression: stderr has full secret");
    // And no cross-stream mask emission — masks only fire on COMPLETE matches.
    assert.equal(r.stdout.includes("***"), false, "stdout should not contain a mask (no full match)");
    assert.equal(r.stderr.includes("***"), false, "stderr should not contain a mask (no full match)");
    // The raw partials should each appear on their original stream.
    assert.ok(r.stdout.includes("RUF") && r.stdout.includes("X"));
    assert.ok(r.stderr.includes("OAUS"));
  });
});

// -----------------------------------------------------------------------------
// Audit + markUsed
// -----------------------------------------------------------------------------

test("POST /v1/run/resolve: markUsed updates last_used_at after a successful run", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "U", value: "v",
    });
    const before = (await ctx.services.vault.inspect(ref)).last_used_at;
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "U", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 200);
    const after = (await ctx.services.vault.inspect(ref)).last_used_at;
    assert.notEqual(after, before, "last_used_at should advance");
    assert.ok(after !== null, "last_used_at should be set");
  });
});

test("POST /v1/run/resolve: pre-spawn secret_not_found writes a per-ref FAILURE audit entry", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: ["ss://x/dev/PROBE"],
      env: [],
      command: process.execPath,
      args: ["-e", ""],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 400);
    assert.equal((r.errorBody as { error_code: string }).error_code, "secret_not_found");
    // The audit log MUST record the attempted use.
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const matches = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "run" && e.ref === "ss://x/dev/PROBE");
    assert.equal(matches.length, 1, "missing-ref probe must be audited");
    assert.equal(matches[0]!.ok, false);
    assert.equal(matches[0]!.error_code, "secret_not_found");
  });
});

test("POST /v1/run/resolve: action_not_allowed writes a per-ref FAILURE audit entry", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const ref = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "NO_STDIN", value: "x",
      allowedActions: ["inject_into_field"],
    });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [ref],
      env: [{ key: "NO_STDIN", value: ref, isRef: true }],
      command: process.execPath,
      args: ["-e", "console.log('NO')"],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 400);
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const matches = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "run" && e.ref === ref);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.ok, false);
    assert.equal(matches[0]!.error_code, "action_not_allowed");
    assert.equal(matches[0]!.environment, "development", "environment is known here — record was resolved");
  });
});

test("POST /v1/run/resolve: audit log gains a per-ref entry per run (success path)", async () => {
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const refA = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "A", value: "a",
    });
    const refB = await seedSecret(ctx.services, {
      source: "x", environment: "development", name: "B", value: "b",
    });
    await callStream(ctx, "/v1/run/resolve", {
      refs: [refA, refB],
      env: [
        { key: "A", value: refA, isRef: true },
        { key: "B", value: refB, isRef: true },
      ],
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
    });
    // Audit file is named `audit.jsonl` (see src/shared/config.ts:31). The
    // canonical helper is getShuttlePaths(home).auditLogPath; we inline the
    // join here to keep the test independent of shared/config imports.
    const auditPath = path.join(ctx.home, "audit.jsonl");
    const lines = (await readFile(auditPath, "utf8")).split("\n").filter((l) => l.length > 0);
    const runEntries = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "run");
    assert.equal(runEntries.length, 2, "expected one audit entry per ref");
    const refsAudited = new Set(runEntries.map((e) => e.ref));
    assert.ok(refsAudited.has(refA));
    assert.ok(refsAudited.has(refB));
    for (const e of runEntries) {
      assert.equal(e.ok, true);
      assert.equal(e.environment, "development");
    }
  });
});

// -----------------------------------------------------------------------------
// spawn_failed wire contract
// -----------------------------------------------------------------------------

test("POST /v1/run/resolve: missing binary → stream error carries exit_code 127 + exit line is 127", async () => {
  // Regression for: spawner emits writeExit(127) but the CLI throws streamError
  // before applying the exit line, so the ShuttleError's exitCode would fall
  // back to the spawn_failed registry default (TRANSIENT=1). Net effect:
  // `secret-shuttle run -- missing-binary` would exit 1, not the POSIX-
  // canonical 127. Fixed by carrying exit_code on the error stream line —
  // daemonErrorFromPayload then preserves it through ShuttleError.exitCode.
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });
    const r = await callStream(ctx, "/v1/run/resolve", {
      refs: [],
      env: [],
      command: "/this/binary/does/not/exist/anywhere",
      args: [],
      cwd: process.cwd(),
    });
    assert.equal(r.status, 200, "spawn_failed surfaces IN the stream, not as a pre-stream HTTP error");
    const errorLine = r.lines.find((l) => "error" in l) as
      | { error: { code: string; message: string; exit_code?: number } }
      | undefined;
    assert.ok(errorLine, "expected an `error` stream line for spawn_failed");
    assert.equal(errorLine.error.code, "spawn_failed");
    assert.equal(
      errorLine.error.exit_code,
      127,
      "error stream line MUST carry exit_code: 127 so the CLI exits with 127, not 1",
    );
    const exitLine = r.lines.find((l) => "exit" in l) as { exit: number } | undefined;
    assert.equal(exitLine?.exit, 127, "exit stream line must also be 127");
  });
});

// -----------------------------------------------------------------------------
// Cancellation
// -----------------------------------------------------------------------------

test("POST /v1/run/resolve: CLI disconnect actually kills the daemon-spawned child (no orphan, no write-after-end)", async () => {
  // POSIX-only: relies on process.kill(pid, 0) probing. Windows kill semantics
  // are different — skip there.
  if (process.platform === "win32") return;
  await withDaemon(async (ctx) => {
    await call(ctx, "POST", "/v1/unlock", { passphrase: "p", set_passphrase: true });

    // The child writes its own PID into a known file as the FIRST thing it does,
    // then sleeps for a long time. The test waits for that PID file to exist
    // (proves the spawn happened), then aborts the fetch, then polls
    // process.kill(pid, 0) until it raises ESRCH (proves the daemon's
    // res.on('close') → AbortController → SIGTERM/SIGKILL chain actually
    // reached the child).
    //
    // Why the PID file matters: a previous draft of this test merely aborted
    // the fetch and asserted elapsed time. That can pass while the child keeps
    // running, because fetch abort returns immediately on the client side
    // regardless of what the daemon does. Probing the actual PID is the only
    // way to prove the child died.
    //
    // ADDITIONALLY: we install a one-shot 'uncaughtException' / 'warning'
    // listener for the duration of the test. The cancellation path calls
    // writer.writeExit(code) AFTER res has closed (because spawnAndStream
    // resolves once the SIGTERMed child exits). Without the writer guard
    // (responseClosed / res.destroyed / res.writableEnded), Node emits
    // ERR_STREAM_WRITE_AFTER_END or worse. This assertion pins the guard.
    const pidFile = path.join(ctx.home, "child.pid");
    const childScript = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      // Sleep effectively forever; we don't want a benign self-exit to mask a bug.
      setInterval(() => {}, 60_000);
    `;

    const uncaughtErrors: Error[] = [];
    const uncaughtWarnings: Error[] = [];
    const onUncaught = (e: Error): void => { uncaughtErrors.push(e); };
    const onWarning = (e: Error): void => {
      // Filter out warnings that aren't relevant to write-after-end. We watch
      // for ERR_STREAM_WRITE_AFTER_END / ERR_STREAM_DESTROYED specifically.
      if (/ERR_STREAM_(WRITE_AFTER_END|DESTROYED)/.test(String(e.message))) {
        uncaughtWarnings.push(e);
      }
    };
    process.on("uncaughtException", onUncaught);
    process.on("warning", onWarning);

    const controller = new AbortController();
    const start = Date.now();
    let childPid: number | null = null;

    try {
      // Kick off the run in the background.
      const runPromise = (async () => {
        try {
          await callStream(
            ctx,
            "/v1/run/resolve",
            {
              refs: [],
              env: [],
              command: process.execPath,
              args: ["-e", childScript],
              cwd: process.cwd(),
            },
            { signal: controller.signal },
          );
        } catch (e) {
          // fetch raises on abort — expected.
          assert.match(String((e as Error).name ?? ""), /Abort/i);
        }
      })();

      // Wait for the child to come up (i.e. the PID file to exist).
      const pidDeadline = Date.now() + 10_000;
      let pidStr: string | null = null;
      while (Date.now() < pidDeadline) {
        try {
          pidStr = await readFile(pidFile, "utf8");
          if (pidStr.trim().length > 0) break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(pidStr !== null && pidStr.trim().length > 0, "child failed to write pid file");
      childPid = Number.parseInt(pidStr!.trim(), 10);
      assert.ok(Number.isFinite(childPid!) && childPid! > 0, "pid file did not contain a valid pid");

      // Sanity: child is actually alive right now.
      let aliveProbe = true;
      try { process.kill(childPid!, 0); } catch { aliveProbe = false; }
      assert.equal(aliveProbe, true, "child should be alive before we abort");

      // Cancel the fetch — closes the HTTP socket → daemon res.on('close') fires
      // → AbortController in the route fires → spawner SIGTERMs the child.
      controller.abort();
      await runPromise;

      // Poll until the child PID is gone. 5s SIGTERM grace + small slack.
      const killDeadline = Date.now() + 8_000;
      let stillAlive = true;
      while (Date.now() < killDeadline) {
        try {
          process.kill(childPid!, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            stillAlive = false;
            break;
          }
          throw e;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const elapsed = Date.now() - start;
      assert.equal(
        stillAlive,
        false,
        `child PID ${childPid} survived the cancel + grace window (took ${elapsed}ms)`,
      );

      // Give Node a tick to surface any deferred write-after-end events from
      // the spawner's post-cancel writeExit call.
      await new Promise((r) => setImmediate(r));
      assert.equal(
        uncaughtErrors.length,
        0,
        `uncaught exception(s) after cancel: ${uncaughtErrors.map((e) => e.message).join("; ")}`,
      );
      assert.equal(
        uncaughtWarnings.length,
        0,
        `write-after-end warning(s) after cancel: ${uncaughtWarnings.map((e) => e.message).join("; ")}`,
      );
    } finally {
      // Test hygiene: if any assertion above fails, the child interval is
      // still alive and would survive for ~60s, costing CPU on every repeat
      // test run. Best-effort SIGKILL.
      if (childPid !== null) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
      process.removeListener("uncaughtException", onUncaught);
      process.removeListener("warning", onWarning);
    }
  });
});
