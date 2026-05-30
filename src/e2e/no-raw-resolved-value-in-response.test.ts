// src/e2e/no-raw-resolved-value-in-response.test.ts
//
// Burst 7 §2 (5q) guard. After the SecretValue migration, no daemon route may
// pass a RAW resolved `.value` (a SecretValue) into a response/serializer — the
// only byte door is `.value.bytes()`. This scans the route files for the
// dangerous patterns. It deliberately does NOT forbid all plaintext in
// responses: inject-render's stdout mode returns the rendered TEMPLATE STRING
// (`content: rendered`), which is a render output, not a SecretValue.value —
// that is the one intentional, agent-requested plaintext-out wire surface (§0).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = join(process.cwd(), "src/daemon/api/routes");

// A resolved SecretValue's value must only ever be read via `.value.bytes()`.
// Flag any resolved-record `.value` access that is NOT immediately followed by
// `.bytes(` / `.dispose(` / `.byteLength` / `.equals(` — i.e. a raw SecretValue
// escaping. TWO access shapes must be caught (verified against the migrated
// run-resolve sink shape `resolved.get(ref)!.value.bytes()`):
//   (1) direct:  `resolved.value` / `secret.value` / `record.value`
//   (2) indexed: `resolved.get(<ref>)!.value` / `.get(...)?.value` / `.get(...).value`
//       — here the token immediately before `.value` is `)`/`!)`/`?)`, NOT the
//         word `resolved`, so a word-boundary `\bresolved\.value` regex would
//         MISS it. The indexed alternative below anchors on `.get(...)`.
const SUSPICIOUS_DIRECT = /\b(resolved|secret|record)\.value\b(?!\s*\.(bytes|dispose|byteLength|equals)\b)/;
const SUSPICIOUS_INDEXED = /\bresolved\.get\([^)]*\)[!?]?\.value\b(?!\s*\.(bytes|dispose|byteLength|equals)\b)/;

// Audited allow-list (Task 2.7 implementer note). A raw `resolved.value` is fine
// when the SecretValue object is handed BY REFERENCE to a Buffer-native internal
// sink that itself reads `.bytes()` and is disposed in the route's `finally` —
// it never reaches a response serializer. The single such site post-migration is
// the templates route passing `secret: resolved.value` into `runTemplate`
// (TemplateRunInput.secret: SecretValue; run.ts copies via `input.secret.bytes()`).
// The skip is anchored to that EXACT field-pass shape so it can never mask a real
// raw-value response leak (a bare `resolved.value` in a returned object would not
// match `secret: resolved.value,`). If a second such audited sink appears, add its
// exact line here — never broaden to a bare `resolved.value` skip.
const ALLOWED_DIRECT_SINKS = [/^\s*secret:\s*resolved\.value,?\s*$/];

test("no daemon route reads a raw resolved SecretValue (.value without .bytes()/.dispose())", () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(ROUTES_DIR, f), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // Skip producer boundaries where `.value` is a page-side capture string
      // being WRAPPED into a SecretValue (SecretValue.fromUtf8(capture.value)).
      if (/SecretValue\.fromUtf8\(/.test(line)) continue;
      // Skip the audited SecretValue-by-reference-into-a-Buffer-native-sink lines
      // (see ALLOWED_DIRECT_SINKS above) — these never serialize plaintext.
      if (ALLOWED_DIRECT_SINKS.some((re) => re.test(line))) continue;
      // NOTE: do NOT blanket-skip every `resolved.get(` line. run-resolve's
      // env-entry ref is `resolved.get(entry.value)` — the `.value` there is an
      // ARGUMENT inside the parens (the ref `entry.value`), which neither
      // SUSPICIOUS regex matches (the direct one requires `resolved|secret|
      // record` immediately before `.value`; `entry` is none of those, and the
      // indexed one only fires on a TRAILING `.value` after `.get(...)`). So a
      // blanket `resolved.get(` skip is both unnecessary and dangerous — it
      // would hide a real raw `resolved.get(ref)!.value` regression. The
      // SUSPICIOUS_INDEXED pattern catches that regression; the legitimate
      // `resolved.get(ref)!.value.bytes()` sink is excluded by the negative
      // lookahead. (If `entry.value`-as-ref ever DID false-match after a
      // refactor, add a narrow skip for the exact ref-argument shape — never a
      // blanket `.get(` skip.)
      if (SUSPICIOUS_DIRECT.test(line) || SUSPICIOUS_INDEXED.test(line)) {
        offenders.push(`${f}:${i + 1}  ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Raw resolved SecretValue read(s) found — use .value.bytes() and dispose:\n${offenders.join("\n")}`,
  );
});

// Burst 7 §2 (5q) guard #2 — `getSecret` is vault-internal-only. After the
// migration, the string-valued Vault.getSecret accessor must NOT be called from
// any route: metadata callers use Vault.inspect, true-plaintext consumers use
// resolveSecret/resolveRefs. `tsc` cannot enforce this (getSecret still returns
// a valid SecretRecord, so a leftover route call type-checks while silently
// keeping a stored plaintext string on the heap before the approval gate). This
// scan is the only mechanism that catches a re-introduced route getSecret.
// Vault internals call it via `this.getSecret(` inside vault.ts; routes called
// `services.vault.getSecret(`. So both: zero `services.vault.getSecret(`
// anywhere, and zero `.getSecret(` outside vault.ts.
test("Vault.getSecret is vault-internal-only — no daemon route/module calls getSecret", () => {
  const DAEMON_DIR = join(process.cwd(), "src/daemon");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".test.ts")) continue;
      const lines = readFileSync(p, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (/services\.vault\.getSecret\(/.test(line) || /\.getSecret\(/.test(line)) {
          offenders.push(`${p.replace(process.cwd() + "/", "")}:${i + 1}  ${line.trim()}`);
        }
      }
    }
  };
  walk(DAEMON_DIR);
  assert.deepEqual(
    offenders,
    [],
    `getSecret called outside vault internals — route metadata callers to Vault.inspect, plaintext consumers to resolveSecret/resolveRefs:\n${offenders.join("\n")}`,
  );
});
