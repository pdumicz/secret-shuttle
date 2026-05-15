import assert from "node:assert/strict";
import test from "node:test";
import { ShuttleError } from "../../shared/errors.js";
import { runTemplate } from "./run.js";

test("runs absolute binary with shell:false; suppresses output", async () => {
  const result = await runTemplate({
    template: {
      id: "echo-stdin",
      description: "",
      binary: process.execPath, // node — absolute on all platforms node ships with
      args: ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.exit(0))"],
      secret_delivery: "stdin",
      required_params: [],
      requires_approval_when_production: false,
    },
    params: {},
    secret: "hidden-value",
  });
  assert.equal(result.exit_code, 0);
  // The result MUST not include stdout/stderr (those are intentionally suppressed).
  assert.equal("stdout" in result, false);
});

test("refuses non-absolute binary", async () => {
  await assert.rejects(
    runTemplate({
      template: {
        id: "x", description: "", binary: "node", args: [],
        secret_delivery: "stdin", required_params: [], requires_approval_when_production: false,
      },
      params: {},
      secret: "x",
    }),
    (err) => err instanceof ShuttleError && err.code === "unsafe_binary_path",
  );
});

test("refuses binary under cwd", async () => {
  const localBin = `${process.cwd()}/some-local-binary`;
  await assert.rejects(
    runTemplate({
      template: {
        id: "x", description: "", binary: localBin, args: [],
        secret_delivery: "stdin", required_params: [], requires_approval_when_production: false,
      },
      params: {},
      secret: "x",
    }),
    (err) => err instanceof ShuttleError && err.code === "unsafe_binary_path",
  );
});

test("refuses missing required param", async () => {
  await assert.rejects(
    runTemplate({
      template: {
        id: "x", description: "", binary: process.execPath, args: ["-e", "0"],
        secret_delivery: "stdin", required_params: ["name"], requires_approval_when_production: false,
      },
      params: {},
      secret: "x",
    }),
    (err) => err instanceof ShuttleError && err.code === "missing_param",
  );
});
