import assert from "node:assert/strict";
import test from "node:test";
import { buildChildEnv, scrubDaemonSecretsFromEnv } from "./safe-env.js";

test("buildChildEnv contains no SECRET_SHUTTLE_* variables", () => {
  process.env.SECRET_SHUTTLE_DAEMON_TOKEN = "tok";
  process.env.SECRET_SHUTTLE_MASTER_KEY = "mk";
  const env = buildChildEnv();
  for (const k of Object.keys(env)) {
    assert.equal(k.startsWith("SECRET_SHUTTLE_"), false, `${k} leaked into child env`);
  }
  assert.equal(typeof env.PATH, "string");
  assert.ok((env.PATH as string).length > 0);
  delete process.env.SECRET_SHUTTLE_DAEMON_TOKEN;
  delete process.env.SECRET_SHUTTLE_MASTER_KEY;
});

test("scrubDaemonSecretsFromEnv deletes token and master key from process.env", () => {
  process.env.SECRET_SHUTTLE_DAEMON_TOKEN = "tok";
  process.env.SECRET_SHUTTLE_MASTER_KEY = "mk";
  scrubDaemonSecretsFromEnv();
  assert.equal(process.env.SECRET_SHUTTLE_DAEMON_TOKEN, undefined);
  assert.equal(process.env.SECRET_SHUTTLE_MASTER_KEY, undefined);
});
