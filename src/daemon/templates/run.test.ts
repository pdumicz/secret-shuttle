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

test("tmp_env_file_0600: spawns with stdio ignore, passes the env-file path in argv, NEVER puts the secret in argv/env", async () => {
  const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rt-"));
  try {
    const argvSidecar = pathModule.join(tmp, "argv.json");
    const recoveredSidecar = pathModule.join(tmp, "recovered.txt");
    const childScript = `
      const fs = require("node:fs");
      const argvPath = process.argv.find(a => a.startsWith("--env-file="))?.slice("--env-file=".length);
      const content = fs.readFileSync(argvPath, "utf8");
      fs.writeFileSync(${JSON.stringify(recoveredSidecar)}, content);
      fs.writeFileSync(${JSON.stringify(argvSidecar)}, JSON.stringify({
        argv: process.argv, env: Object.fromEntries(Object.entries(process.env)),
      }));
    `;
    const { runTemplate } = await import("./run.js");
    const r = await runTemplate({
      template: {
        id: "fake-env-file", description: "", binary: process.execPath,
        args: ["-e", childScript, "--"],
        secret_delivery: "tmp_env_file_0600",
        required_params: ["name"],
        requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: { name: "STRIPE_SECRET_KEY" },
      secret: "needle-7c4d-do-not-leak",
      tmpDir: tmp,
    });
    assert.equal(r.exit_code, 0);
    const recovered = await readFile(recoveredSidecar, "utf8");
    assert.equal(recovered, "STRIPE_SECRET_KEY=needle-7c4d-do-not-leak\n");
    const { argv, env } = JSON.parse(await readFile(argvSidecar, "utf8")) as { argv: string[]; env: Record<string,string> };
    assert.ok(argv.some((a) => a.startsWith("--env-file=") && a.endsWith(".env")), "argv must contain --env-file=<path>");
    for (const a of argv) {
      assert.equal(a.includes("needle-7c4d-do-not-leak"), false, `argv leaked secret: ${a}`);
    }
    for (const [k, v] of Object.entries(env)) {
      assert.equal((k + "=" + v).includes("needle-7c4d-do-not-leak"), false, `env leaked secret: ${k}=${v}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: unlinks the env-file on success", async () => {
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rtu-"));
  try {
    const { runTemplate } = await import("./run.js");
    await runTemplate({
      template: {
        id: "fake-env-file", description: "", binary: process.execPath,
        args: ["-e", "process.exit(0)"],
        secret_delivery: "tmp_env_file_0600",
        required_params: [], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: {},
      secret: "x",
      tmpDir: tmp,
    });
    const remaining = await readdir(tmp);
    assert.deepEqual(remaining, [], "the env-file must be unlinked on success");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: unlinks the env-file even when the child exits non-zero", async () => {
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rtnz-"));
  try {
    const { runTemplate } = await import("./run.js");
    const r = await runTemplate({
      template: {
        id: "fake-env-file", description: "", binary: process.execPath,
        args: ["-e", "process.exit(7)"],
        secret_delivery: "tmp_env_file_0600",
        required_params: [], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: {},
      secret: "x",
      tmpDir: tmp,
    });
    assert.equal(r.exit_code, 7);
    const remaining = await readdir(tmp);
    assert.deepEqual(remaining, [], "the env-file must be unlinked even on non-zero exit");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: throws bad_request when value_arg_template is missing", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathModule = await import("node:path");
  const tmp = await mkdtemp(pathModule.join(tmpdir(), "ss-rtnvat-"));
  try {
    const { runTemplate } = await import("./run.js");
    const { ShuttleError } = await import("../../shared/errors.js");
    await assert.rejects(
      runTemplate({
        template: {
          id: "x", description: "", binary: process.execPath, args: ["-e", "0"],
          secret_delivery: "tmp_env_file_0600",
          required_params: [], requires_approval_when_production: false,
        },
        params: {},
        secret: "x",
        tmpDir: tmp,
      }),
      (err: unknown) => err instanceof ShuttleError && err.code === "template_definition_invalid",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tmp_env_file_0600: throws bad_request when tmpDir is missing on the input", async () => {
  const { runTemplate } = await import("./run.js");
  const { ShuttleError } = await import("../../shared/errors.js");
  await assert.rejects(
    runTemplate({
      template: {
        id: "x", description: "", binary: process.execPath, args: ["-e", "0"],
        secret_delivery: "tmp_env_file_0600",
        required_params: [], requires_approval_when_production: false,
        value_arg_template: "--env-file={{__env_file_path__}}",
      },
      params: {},
      secret: "x",
    }),
    (err: unknown) => err instanceof ShuttleError && err.code === "template_tmpdir_missing",
  );
});
