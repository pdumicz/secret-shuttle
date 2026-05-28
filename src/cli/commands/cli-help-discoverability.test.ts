import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execp = promisify(execFile);
const CLI = join(process.cwd(), "dist/cli/index.js");

// `npm test` runs `npm run build` first (see package.json:scripts.test), so
// dist/cli/index.js exists by the time this test runs. The pattern matches
// bootstrap-removed.test.ts and provision.test.ts.
test("--help mentions AGENT QUICKSTART + SKILL.md", async () => {
  const r = await execp("node", [CLI, "--help"]);
  assert.match(r.stdout, /AGENT QUICKSTART/);
  assert.match(r.stdout, /SKILL\.md/);
});
