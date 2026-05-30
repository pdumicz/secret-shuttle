// src/cli/commands/identity-config.test.ts
//
// Burst 7 §1 (Plan 5s). Opt-in via `identity.perProject` in
// secret-shuttle.config.json. The loader mirrors loadInferConfig's defensive
// pattern (missing file / malformed JSON / non-object / non-boolean → false).
// The writer MERGES identity.perProject into an existing config, preserving
// infer.* (spec §1 + §6 risk: "flag clobbers an existing infer.* block").
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadIdentityPerProject, writePerProjectIdentity } from "./identity-config.js";

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ss-identity-config-"));
}

test("loadIdentityPerProject: perProject:true is honored", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: true } }));
    assert.equal(await loadIdentityPerProject(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadIdentityPerProject: missing file → false", async () => {
  const dir = await tmp();
  try {
    assert.equal(await loadIdentityPerProject(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadIdentityPerProject: malformed JSON / non-object identity / non-boolean → false", async () => {
  const dir = await tmp();
  try {
    await writeFile(join(dir, "secret-shuttle.config.json"), "{ not valid json");
    assert.equal(await loadIdentityPerProject(dir), false);
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: "nope" }));
    assert.equal(await loadIdentityPerProject(dir), false);
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: "yes" } }));
    assert.equal(await loadIdentityPerProject(dir), false);
    await writeFile(join(dir, "secret-shuttle.config.json"), JSON.stringify({ identity: { perProject: 1 } }));
    assert.equal(await loadIdentityPerProject(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePerProjectIdentity: creates the file when absent", async () => {
  const dir = await tmp();
  try {
    await writePerProjectIdentity(dir);
    const parsed = JSON.parse(await readFile(join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.deepEqual(parsed, { identity: { perProject: true } });
    assert.equal(await loadIdentityPerProject(dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePerProjectIdentity: merges into an existing config WITHOUT clobbering infer.*", async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ infer: { supabaseNames: ["DATABASE_SERVICE_KEY"] } }, null, 2),
    );
    await writePerProjectIdentity(dir);
    const parsed = JSON.parse(await readFile(join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.deepEqual(parsed.infer, { supabaseNames: ["DATABASE_SERVICE_KEY"] }, "infer.* preserved");
    assert.deepEqual(parsed.identity, { perProject: true }, "identity.perProject merged in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writePerProjectIdentity: preserves an existing identity sibling key", async () => {
  const dir = await tmp();
  try {
    await writeFile(
      join(dir, "secret-shuttle.config.json"),
      JSON.stringify({ identity: { somethingElse: 42 } }),
    );
    await writePerProjectIdentity(dir);
    const parsed = JSON.parse(await readFile(join(dir, "secret-shuttle.config.json"), "utf8"));
    assert.equal(parsed.identity.somethingElse, 42, "sibling identity keys preserved");
    assert.equal(parsed.identity.perProject, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
