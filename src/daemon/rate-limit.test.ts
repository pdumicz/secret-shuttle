import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../shared/errors.js";
import { RateLimiter } from "./rate-limit.js";

test("RateLimiter allows up to limit then throws compare_rate_limited", () => {
  let now = 0;
  const rl = new RateLimiter(3, 1000, () => now);
  rl.check("k"); rl.check("k"); rl.check("k");
  assert.throws(
    () => rl.check("k"),
    (e) => e instanceof ShuttleError && e.code === "compare_rate_limited",
  );
  now = 1001; // window elapsed
  assert.doesNotThrow(() => rl.check("k"));
});

test("RateLimiter is per-key", () => {
  const rl = new RateLimiter(1, 1000, () => 0);
  rl.check("a");
  assert.doesNotThrow(() => rl.check("b"));
});
