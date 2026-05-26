import test from "node:test";
import assert from "node:assert/strict";
import { BootstrapStore } from "./store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("BatchState carries owner_agent_id field (schema acceptance)", async () => {
  const store = new BootstrapStore({ rootDir: mkdtempSync(path.join(tmpdir(), "ss-batch-")) });
  await store.save({
    batch_id: "b1",
    approval_id: "a",
    plan_file_path: "/tmp",
    plan: [],
    step_results: {},
    created_at: Date.now(),
    status: "pending",
    owner_agent_id: "claude-abc",
  });
  const back = await store.get("b1");
  assert.equal(back?.owner_agent_id, "claude-abc");
});
