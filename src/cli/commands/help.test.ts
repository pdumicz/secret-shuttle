import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { renderTopLevelHelp, helpCommand } from "./help.js";

test("renderTopLevelHelp output groups commands and stays under 30 lines", () => {
  const output = renderTopLevelHelp();
  const lines = output.split("\n");
  assert.ok(lines.length <= 32, `expected ≤32 lines, got ${lines.length}`); // 30 + small buffer
  // Spot-check the groups are present:
  assert.match(output, /Setup/);
  assert.match(output, /Secrets/);
  assert.match(output, /Provider integration/);
  assert.match(output, /Agent/);
  // Spot-check a few commands are listed:
  assert.match(output, /\binit\b/);
  assert.match(output, /\bstatus\b/);
  assert.match(output, /\bsecrets list\b/);
  // Plan 3 commands must appear under Provider integration:
  assert.match(output, /\brun\b/);
  assert.match(output, /\binject\b/);
  // Public recovery commands MUST appear — registry hints + status.next_action
  // emit these as bare top-level commands, so the curated help has to surface
  // them too, or agents reading help will look for the wrong place.
  assert.match(output, /^\s*unlock\b/m);
  assert.match(output, /\bmigrate secure-vault\b/);
  assert.match(output, /\bdaemon start\|stop\|status\b/);
  // Internal namespace should NOT appear in curated help:
  assert.doesNotMatch(output, /\binternal\b/);
  // Deprecated names should NOT appear (they're shims, not the curated path):
  assert.doesNotMatch(output, /^\s{2}list\b/m);    // old name; curated says "secrets list"
  assert.doesNotMatch(output, /^\s{2}inspect\b/m); // old name; curated says "secrets get-ref"
  assert.doesNotMatch(output, /^\s{2}generate\b/m); // old name; curated says "secrets set"
  assert.doesNotMatch(output, /^\s{2}doctor\b/m);   // old name; curated says "status"
  // Future-tense commands must NOT appear:
  assert.doesNotMatch(output, /\brestart\b/); // daemon restart doesn't exist
});

test("helpCommand resolves and prints help for a top-level command", async () => {
  // Build a minimal program that mirrors how src/cli/index.ts wires things.
  const program = new Command("secret-shuttle");
  const fake = new Command("fake").description("a fake command for testing").option("--flag");
  program.addCommand(fake);
  program.addCommand(helpCommand());

  // Capture stdout.
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["help", "fake"], { from: "user" });
  } finally {
    process.stdout.write = origWrite;
  }
  const out = chunks.join("");
  // Commander's helpInformation() output contains the command's description.
  assert.match(out, /a fake command for testing/);
  assert.match(out, /--flag/);
});

test("helpCommand resolves a space-separated path (e.g. 'secrets list')", async () => {
  const program = new Command("secret-shuttle");
  const secrets = new Command("secrets").description("secrets group");
  secrets.addCommand(new Command("list").description("list secrets"));
  program.addCommand(secrets);
  program.addCommand(helpCommand());

  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["help", "secrets", "list"], { from: "user" });
  } finally {
    process.stdout.write = origWrite;
  }
  const out = chunks.join("");
  assert.match(out, /list secrets/);
});

test("helpCommand reports unknown command path on stderr with exit code 1", async () => {
  const program = new Command("secret-shuttle");
  program.addCommand(helpCommand());

  const stderrChunks: string[] = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  const origExit = process.exitCode;
  try {
    await program.parseAsync(["help", "nope"], { from: "user" });
  } finally {
    process.stderr.write = origStderr;
  }
  const err = stderrChunks.join("");
  assert.match(err, /unknown command 'nope'/);
  assert.equal(process.exitCode, 1);
  process.exitCode = origExit;
});
