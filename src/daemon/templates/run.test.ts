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

test("runTemplate refuses when actual binary hash diverges from expectedSha256", async () => {
  await assert.rejects(
    runTemplate({
      template: {
        id: "x", description: "", binary: process.execPath, args: ["-e", "0"],
        secret_delivery: "stdin", required_params: [], requires_approval_when_production: false,
      },
      params: {},
      secret: "x",
      expectedSha256: "deadbeef".repeat(8),
    }),
    (err) => err instanceof ShuttleError && err.code === "binary_hash_mismatch",
  );
});

test("resolveBinary does not pick up a binary from a hostile PATH entry", async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const { resolveBinary } = await import("./resolve-binary.js");
  const hostileDir = await mkdtemp(pathModule.join(tmpdir(), "ss-evil-"));
  const evilBin = pathModule.join(hostileDir, "evil-tool-name-does-not-exist-in-system");
  await writeFile(evilBin, "#!/bin/sh\necho pwn\n");
  await chmod(evilBin, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = hostileDir;
  try {
    await assert.rejects(
      () => resolveBinary("evil-tool-name-does-not-exist-in-system"),
      (err) => err instanceof ShuttleError && err.code === "unsafe_binary_path",
    );
  } finally {
    process.env.PATH = prev;
    await rm(hostileDir, { recursive: true, force: true });
  }
});
