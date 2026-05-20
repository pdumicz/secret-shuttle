import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// dist/daemon/templates → up 3 to the repo root → docs/templates-deferred.md
const DOC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/templates-deferred.md",
);

test("docs/templates-deferred.md names each deferred template with a rationale", async () => {
  const md = await readFile(DOC, "utf8");
  for (const id of ["railway-variable-set", "netlify-env-set", "clerk-env-set"]) {
    assert.match(md, new RegExp(id), `missing template id: ${id}`);
  }
  assert.match(md, /argv|process table|first-party CLI|dashboard/i);
});

test("docs/templates-deferred.md does NOT misrepresent any deferred template as shipped", async () => {
  const md = await readFile(DOC, "utf8");
  for (const shipped of [
    "vercel-env-add", "github-actions-secret-set", "cloudflare-secret-put", "supabase-edge-secret-set",
  ]) {
    assert.equal(md.includes(shipped), false, `${shipped} is shipped — it does not belong in templates-deferred.md`);
  }
});
