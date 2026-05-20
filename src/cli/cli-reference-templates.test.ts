import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/cli-reference.md",
);

test("docs/cli-reference.md names every shipped template and its delivery mode", async () => {
  const md = await readFile(REF, "utf8");
  for (const id of ["vercel-env-add", "github-actions-secret-set", "cloudflare-secret-put", "supabase-edge-secret-set"]) {
    assert.match(md, new RegExp(id), `missing template id: ${id}`);
  }
  assert.match(md, /stdin/);
  assert.match(md, /tmp_env_file_0600|0600 env-file|env-file/);
});

test("docs/cli-reference.md template section names the required params per template", async () => {
  const md = await readFile(REF, "utf8");
  assert.match(md, /vercel-env-add[\s\S]{0,800}name=.+environment=/);
  assert.match(md, /github-actions-secret-set[\s\S]{0,800}name=.+repo=/);
  assert.match(md, /cloudflare-secret-put[\s\S]{0,800}name=/);
  assert.match(md, /supabase-edge-secret-set[\s\S]{0,800}name=/);
});
