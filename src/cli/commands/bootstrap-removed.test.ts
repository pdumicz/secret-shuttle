import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execp = promisify(execFile);

const CLI = join(process.cwd(), "dist/cli/index.js");

test("`secret-shuttle bootstrap` exits 2 with command_renamed JSON pointing at provision", async () => {
  // The top-level catch in src/cli/index.ts writes error JSON to stderr
  // (not stdout) and sets process.exitCode. We read e.stderr accordingly.
  let stderr = "";
  let exitCode = 0;
  try {
    const r = await execp("node", [CLI, "bootstrap"]);
    stderr = r.stderr;
  } catch (e: any) {
    stderr = e.stderr ?? "";
    exitCode = e.code ?? 1;
  }
  assert.equal(exitCode, 2, `expected exit 2, got ${exitCode}`);
  const parsed = JSON.parse(stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error_code, "command_renamed");
  assert.match(parsed.message, /provision/);
});
