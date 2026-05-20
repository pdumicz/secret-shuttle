import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { getShuttlePaths, getSecretShuttleHome } from "./config.js";

test("getShuttlePaths exposes a daemonTmpPath under the home dir", () => {
  const p = getShuttlePaths("/tmp/ss-test-home");
  assert.equal(p.daemonTmpPath, path.join("/tmp/ss-test-home", "tmp"));
});

test("getShuttlePaths daemonTmpPath defaults under getSecretShuttleHome() when no arg", () => {
  const p = getShuttlePaths();
  assert.equal(p.daemonTmpPath, path.join(getSecretShuttleHome(), "tmp"));
});
