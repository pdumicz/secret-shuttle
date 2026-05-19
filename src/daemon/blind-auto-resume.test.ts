import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DaemonServices } from "./services.js";
import { autoResumeBlind } from "./blind-auto-resume.js";
import { getShuttlePaths } from "../shared/config.js";

test("autoResumeBlind ends blind WITHOUT approval/blank and writes a distinct blind_auto_resume audit record", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-ar-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    services.blind.start("vercel.com", "inject_submit");
    assert.notEqual(services.blind.current(), null);

    await autoResumeBlind(services, {
      op: "inject_submit", domain: "vercel.com",
      success_signal: "text_matched", absence_proof: "passed",
    });

    assert.equal(services.blind.current(), null);
    const log = await readFile(getShuttlePaths(home).auditLogPath, "utf8");
    const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const rec = lines.find((l) => l.action === "blind_auto_resume");
    assert.ok(rec, "a blind_auto_resume record must exist");
    assert.equal(rec!.ok, true);
    assert.equal(rec!.domain, "vercel.com");
    assert.equal(rec!.op, "inject_submit");
    assert.equal(rec!.success_signal, "text_matched");
    assert.equal(rec!.absence_proof, "passed");
    // It must NOT be a blind_end record (the human path is separate & unchanged).
    assert.equal(lines.some((l) => l.action === "blind_end"), false);
    // §7: the record must never carry the secret / observed text. The only
    // value-ish key is the *negative* audit flag `value_visible_to_agent`
    // (a boolean === false, not a content channel); any OTHER key matching
    // /value|secret|text|observed/ would be a secret-bearing channel.
    assert.equal(rec!.value_visible_to_agent, false, "auto-resume must audit that the secret was NOT agent-visible");
    assert.equal(
      Object.keys(rec!).some((k) => k !== "value_visible_to_agent" && /value|secret|text|observed/i.test(k)),
      false,
      "audit record must not carry a secret/observed-text channel",
    );
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test("autoResumeBlind refuses (throws) if its preconditions are not both passed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-ar-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try {
    const services = new DaemonServices();
    services.blind.start("vercel.com", "inject_submit");
    await assert.rejects(
      () => autoResumeBlind(services, {
        op: "inject_submit", domain: "vercel.com",
        success_signal: "text_matched",
        // @ts-expect-error intentionally wrong to prove the guard
        absence_proof: "inconclusive",
      }),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "auto_resume_precondition",
    );
    assert.notEqual(services.blind.current(), null); // stays blind
    // §7: a refusal is a true no-op — it must write ZERO audit lines.
    const audit = await readFile(getShuttlePaths(home).auditLogPath, "utf8")
      .then((c) => c.trim())
      .catch(() => "");
    assert.equal(audit, "", "refused auto-resume must write no audit log");
  } finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});
