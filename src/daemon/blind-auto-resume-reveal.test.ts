import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServices } from "./services.js";
import { autoResumeBlind } from "./blind-auto-resume.js";
import { getShuttlePaths } from "../shared/config.js";

test("autoResumeBlind ends blind for op:reveal_capture with success_signal:secret_captured and writes a distinct blind_auto_resume record", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-arr-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    services.blind.start("dashboard.stripe.com", "reveal_capture");
    assert.notEqual(services.blind.current(), null);

    await autoResumeBlind(services, {
      op: "reveal_capture", domain: "dashboard.stripe.com",
      success_signal: "secret_captured", absence_proof: "passed",
    });

    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const rec = lines.find((l) => l.action === "blind_auto_resume");
    assert.ok(rec, "a blind_auto_resume record must exist");
    assert.equal(rec!.ok, true);
    assert.equal(rec!.domain, "dashboard.stripe.com");
    assert.equal(rec!.op, "reveal_capture");
    assert.equal(rec!.success_signal, "secret_captured");
    assert.equal(rec!.absence_proof, "passed");
    assert.equal(lines.some((l) => l.action === "blind_end"), false);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("autoResumeBlind still accepts the Phase-2 inject_submit/text_matched signal (backward compatible)", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-arr2-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    services.blind.start("vercel.com", "inject_submit");
    await autoResumeBlind(services, {
      op: "inject_submit", domain: "vercel.com",
      success_signal: "text_matched", absence_proof: "passed",
    });
    assert.equal(services.blind.current(), null);
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("autoResumeBlind refuses (throws auto_resume_precondition) for reveal_capture if the proof is not passed; stays blind", async () => {
  const services = new DaemonServices();
  services.blind.start("dashboard.stripe.com", "reveal_capture");
  await assert.rejects(
    () => autoResumeBlind(services, {
      op: "reveal_capture", domain: "dashboard.stripe.com",
      success_signal: "secret_captured",
      // @ts-expect-error intentionally wrong to prove the guard
      absence_proof: "inconclusive",
    }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "auto_resume_precondition",
  );
  assert.notEqual(services.blind.current(), null);
});

test("autoResumeBlind refuses (throws auto_resume_precondition) for reveal_capture if success_signal is neither text_matched nor secret_captured even when the proof passed; stays blind", async () => {
  const services = new DaemonServices();
  services.blind.start("dashboard.stripe.com", "reveal_capture");
  await assert.rejects(
    () => autoResumeBlind(services, {
      op: "reveal_capture", domain: "dashboard.stripe.com",
      // @ts-expect-error intentionally invalid signal to prove the success_signal guard branch fails closed
      success_signal: "secret_revealed",
      absence_proof: "passed",
    }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "auto_resume_precondition",
  );
  assert.notEqual(services.blind.current(), null);
});
