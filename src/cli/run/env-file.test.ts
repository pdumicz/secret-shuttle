import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, type EnvFileEntry } from "./env-file.js";

test("parseEnvFile: empty input returns empty entries", () => {
  const r = parseEnvFile("");
  assert.deepEqual(r.entries, []);
});

test("parseEnvFile: bare KEY=VALUE pair (non-ref)", () => {
  const r = parseEnvFile("PORT=3000\n");
  assert.deepEqual(r.entries, [{ key: "PORT", value: "3000", isRef: false }]);
});

test("parseEnvFile: KEY=ss://... resolves as ref (canonicalized env)", () => {
  // 'prod' is the canonical SHORT form used in buildSecretRef / ref field.
  // parseSecretRef("ss://stripe/prod/STRIPE_KEY").ref === "ss://stripe/prod/STRIPE_KEY"
  // because refEnvironment("production") === "prod".
  const r = parseEnvFile("STRIPE_KEY=ss://stripe/prod/STRIPE_KEY\n");
  assert.deepEqual(r.entries, [{ key: "STRIPE_KEY", value: "ss://stripe/prod/STRIPE_KEY", isRef: true }]);
});

test("parseEnvFile: NAME_RE mixed-case + dashes + dots are valid ref names", () => {
  // The canonical NAME_RE is [A-Za-z_][A-Za-z0-9_.-]*. A real-world ref like
  // ss://local/dev/my-key.v2 MUST be detected as a ref, not treated as literal.
  const r = parseEnvFile("MY_KEY=ss://local/dev/my-key.v2\n");
  assert.deepEqual(r.entries, [{ key: "MY_KEY", value: "ss://local/dev/my-key.v2", isRef: true }]);
});

test("parseEnvFile: malformed full-value ss:// → env_file_parse_error (fail closed)", () => {
  // Trailing slash → fails parseSecretRef → throws.
  // Rationale: an unparseable full-value ss:// is almost always a typo. Silently
  // passing it to the child as a literal string is harder to diagnose than failing.
  // The existing "partial ss:// substring is NOT a ref" test above pins the
  // counterpart rule: substring ss:// stays literal (no throw).
  assert.throws(
    () => parseEnvFile("BROKEN=ss://x/dev/\n"),
    (err: Error & { code?: string }) => err.code === "env_file_parse_error",
  );
});

test("parseEnvFile: comments and blank lines are ignored", () => {
  const r = parseEnvFile("# this is a comment\n\nPORT=3000\n\n# another\nLOG_LEVEL=info\n");
  assert.deepEqual(r.entries, [
    { key: "PORT", value: "3000", isRef: false },
    { key: "LOG_LEVEL", value: "info", isRef: false },
  ]);
});

test("parseEnvFile: double-quoted values are unquoted; backslash NOT expanded", () => {
  const r = parseEnvFile('GREETING="hello \\n world"\n');
  assert.deepEqual(r.entries, [{ key: "GREETING", value: "hello \\n world", isRef: false }]);
});

test("parseEnvFile: partial ss:// substring is NOT a ref", () => {
  // Value contains ss:// but is not the entire value → verbatim non-ref.
  const r = parseEnvFile("MOTD=visit ss://stripe/prod/STRIPE_KEY for keys\n");
  assert.deepEqual(r.entries, [{ key: "MOTD", value: "visit ss://stripe/prod/STRIPE_KEY for keys", isRef: false }]);
});

test("parseEnvFile: invalid key name throws env_file_parse_error", () => {
  assert.throws(
    () => parseEnvFile("lowercase=value\n"),
    (err: Error & { code?: string }) => err.code === "env_file_parse_error",
  );
});

test("parseEnvFile: missing = throws env_file_parse_error", () => {
  assert.throws(
    () => parseEnvFile("NO_EQUALS_HERE\n"),
    (err: Error & { code?: string }) => err.code === "env_file_parse_error",
  );
});

test("parseEnvFile: line number is reported in error message", () => {
  let caught: Error | undefined;
  try {
    parseEnvFile("VALID=1\nINVALID\nSTILL_VALID=2\n");
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(caught);
  assert.match(caught.message, /line 2/i);
});

test("parseEnvFile: ${VAR} expansion is not supported — treated as literal", () => {
  const r = parseEnvFile("FOO=${BAR}_suffix\n");
  assert.deepEqual(r.entries, [{ key: "FOO", value: "${BAR}_suffix", isRef: false }]);
});

test("parseEnvFile: quoted ss:// ref is unquoted and detected as ref (canonicalized)", () => {
  const r = parseEnvFile('STRIPE_KEY="ss://stripe/prod/STRIPE_KEY"\n');
  assert.deepEqual(r.entries, [{ key: "STRIPE_KEY", value: "ss://stripe/prod/STRIPE_KEY", isRef: true }]);
});

test("parseEnvFile: strips a leading UTF-8 BOM", () => {
  // Some editors (notably Windows Notepad) prepend a BOM. Without stripping,
  // the BOM becomes part of the line-1 key and produces a confusing
  // "invalid key" error.
  const r = parseEnvFile("﻿PORT=3000\n");
  assert.deepEqual(r.entries, [{ key: "PORT", value: "3000", isRef: false }]);
});

test("parseEnvFile: handles CRLF line endings (Windows-style)", () => {
  const r = parseEnvFile("PORT=3000\r\nLOG_LEVEL=info\r\n");
  assert.deepEqual(r.entries, [
    { key: "PORT", value: "3000", isRef: false },
    { key: "LOG_LEVEL", value: "info", isRef: false },
  ]);
});

test("parseEnvFile: bare 'ss://' (no path components) triggers fail-closed throw", () => {
  // Completes the fail-closed story alongside the trailing-slash case.
  assert.throws(
    () => parseEnvFile("BARE=ss://\n"),
    (err: Error & { code?: string }) => err.code === "env_file_parse_error",
  );
});
