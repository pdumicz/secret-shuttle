import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeDaemonAudit } from "./audit.js";

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-audit-"));
  const prev = process.env.SECRET_SHUTTLE_HOME;
  process.env.SECRET_SHUTTLE_HOME = home;
  try { await fn(home); }
  finally {
    if (prev === undefined) delete process.env.SECRET_SHUTTLE_HOME;
    else process.env.SECRET_SHUTTLE_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
}

test("writeDaemonAudit appends a JSON line with timestamp and never_visible flag", async () => {
  await withHome(async (home) => {
    await writeDaemonAudit({ action: "unlock", ok: true });
    const content = await readFile(path.join(home, "audit.jsonl"), "utf8");
    const parsed = JSON.parse(content.trim()) as { ts: string; action: string; ok: boolean; value_visible_to_agent: boolean };
    assert.equal(parsed.action, "unlock");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value_visible_to_agent, false);
    assert.equal(typeof parsed.ts, "string");
  });
});

test("multiple writes append on separate lines", async () => {
  await withHome(async (home) => {
    await writeDaemonAudit({ action: "approval_created", ok: true, approval_id: "a1" });
    await writeDaemonAudit({ action: "approval_granted", ok: true, approval_id: "a1" });
    const lines = (await readFile(path.join(home, "audit.jsonl"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
  });
});

test("error_code is preserved on failed actions", async () => {
  await withHome(async (home) => {
    await writeDaemonAudit({ action: "inject", ok: false, error_code: "approval_denied" });
    const content = JSON.parse((await readFile(path.join(home, "audit.jsonl"), "utf8")).trim()) as { error_code: string };
    assert.equal(content.error_code, "approval_denied");
  });
});
