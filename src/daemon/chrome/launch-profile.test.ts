import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { launchChrome } from "./launch.js";

for (const bad of ["../escape", "..", ".", "a/b", "/abs", "with space", "x".repeat(65), ""]) {
  test(`launchChrome rejects unsafe profile name ${JSON.stringify(bad)}`, async () => {
    await assert.rejects(
      () => launchChrome({ profile: bad }),
      (e) => e instanceof ShuttleError && e.code === "invalid_profile",
    );
  });
}
