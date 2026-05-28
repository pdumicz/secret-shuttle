import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readBoundedJson } from "./bounded-json.js";

function reqFrom(text: string): any {
  return Object.assign(Readable.from(Buffer.from(text, "utf8")), {
    socket: { remoteAddress: "127.0.0.1" },
  });
}

test("valid JSON within bound parses", async () => {
  const r = await readBoundedJson(reqFrom('{"x":1}'), 1024);
  assert.deepEqual(r, { x: 1 });
});

test("empty body → bad_request by default", async () => {
  await assert.rejects(readBoundedJson(reqFrom(""), 1024), /Empty body/);
});

test("empty body → {} when allowEmpty: true", async () => {
  const r = await readBoundedJson(reqFrom(""), 1024, { allowEmpty: true });
  assert.deepEqual(r, {});
});

test("oversize → request_too_large", async () => {
  await assert.rejects(readBoundedJson(reqFrom("x".repeat(2048)), 1024), /Body exceeds/);
});

test("malformed JSON → bad_request", async () => {
  await assert.rejects(readBoundedJson(reqFrom("{not json"), 1024), /Malformed JSON/);
});
