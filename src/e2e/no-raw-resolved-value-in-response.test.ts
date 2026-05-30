// src/e2e/no-raw-resolved-value-in-response.test.ts
//
// Burst 7 §2 (5q) guard. After the SecretValue migration, no daemon route may
// read a RAW resolved `.value` (a SecretValue) other than through the audited
// byte door `.value.bytes()` (plus the inspection helpers .dispose()/.byteLength/
// .equals()) or by handing the whole SecretValue BY REFERENCE to a Buffer-native
// internal sink. This guard is TYPE-AWARE (TypeScript compiler API) rather than
// regex/name-based: it resolves the static type of every `.value` access in the
// route files and flags only those whose type is the `SecretValue` class — so it
// catches a raw read regardless of the receiver's variable name. A regex pinned
// to `resolved|secret|record` would MISS a loop alias such as
// `for (const r of resolved.values()) return { value: r.value }` (the receiver
// `r` is none of those names) — exactly the realistic future miss this rewrite
// closes. It deliberately does NOT forbid all plaintext in responses:
// inject-render's stdout mode returns the rendered TEMPLATE STRING
// (`content: rendered`), which is a `string`, not a `SecretValue` — that is the
// one intentional, agent-requested plaintext-out wire surface (§0).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROUTES_DIR = join(process.cwd(), "src/daemon/api/routes");
const TSCONFIG = join(process.cwd(), "tsconfig.json");

// Reading a SecretValue is allowed only when the access is the receiver of one
// of these member calls (the audited "doors"): `.bytes()` is the single plaintext
// door; the others are non-leaking inspection/lifecycle helpers.
const ALLOWED_MEMBERS = new Set(["bytes", "dispose", "byteLength", "equals"]);

/**
 * Build a typed Program over the route files (resolving their imports via the
 * repo tsconfig) so the checker can tell a `SecretValue`-typed `.value` from a
 * plain-string `.value` (e.g. `entry.value`, `capture.value`, `o.value`).
 */
function buildProgram(routeFiles: string[]): ts.Program {
  const cfg = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    process.cwd(),
  );
  return ts.createProgram(routeFiles, {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
  });
}

/** True iff `type` is (or includes, for a union) the `SecretValue` class. */
function isSecretValueType(type: ts.Type): boolean {
  const named = (t: ts.Type): boolean => t.getSymbol()?.getName() === "SecretValue";
  if (type.isUnion()) return type.types.some(named);
  return named(type);
}

/**
 * Audited by-reference handoff check. A raw SecretValue (not `.value.bytes()`) is
 * permitted when it is handed BY REFERENCE into a Buffer-native internal sink
 * that itself reads `.bytes()` and disposes in the route's `finally` — it never
 * reaches a response serializer. The two such sites post-migration are:
 *   - templates  → `runTemplate({ secret: resolved.value, ... })`  (TemplateRunInput.secret: SecretValue)
 *   - secrets-import → `upsertSecret({ value: entry.value, ... })` (UpsertSecretInput.value: SecretValue)
 * Rather than name-allow-listing the property (which would have to allow `value`
 * — the very field a leaked wire-response object would use — and so could mask a
 * real leak), this is TYPE-DIRECTED: the SecretValue access is the initializer of
 * a property of an object literal that is a DIRECT ARGUMENT of a call, AND the
 * call's contextual (parameter) type declares that property as `SecretValue`. A
 * returned/response object literal is NOT a call argument, and its contextual
 * type's `value` property is `string`/absent — so `return { value: r.value }`
 * can never satisfy this and is still flagged.
 */
function isByRefSinkHandoff(valueAccess: ts.Expression, checker: ts.TypeChecker): boolean {
  const prop = valueAccess.parent;
  if (!ts.isPropertyAssignment(prop) || prop.initializer !== valueAccess) return false;
  if (!ts.isIdentifier(prop.name)) return false;
  const objLit = prop.parent;
  if (!ts.isObjectLiteralExpression(objLit)) return false;
  // The object literal must itself be a direct argument of a call expression.
  const call = objLit.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(objLit)) return false;
  // The parameter (contextual) type the object flows into must declare this
  // property as a SecretValue — i.e. the callee asked for the SecretValue by
  // reference. A response object has no such contextual SecretValue property.
  const ctxType = checker.getContextualType(objLit);
  if (ctxType === undefined) return false;
  const propSym = ctxType.getProperty(prop.name.text);
  if (propSym === undefined) return false;
  const propType = checker.getTypeOfSymbolAtLocation(propSym, objLit);
  return isSecretValueType(propType);
}

test("no daemon route reads a raw resolved SecretValue (.value without .bytes()/.dispose())", () => {
  const files = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(ROUTES_DIR, f));
  const program = buildProgram(files);
  const checker = program.getTypeChecker();
  const offenders: string[] = [];

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (sf === undefined) continue;
    const rel = file.replace(process.cwd() + "/", "");

    const visit = (node: ts.Node): void => {
      // Match BOTH `x.value` (PropertyAccess) and `x["value"]` (ElementAccess).
      let valueAccess: ts.Expression | undefined;
      if (ts.isPropertyAccessExpression(node) && node.name.text === "value") {
        valueAccess = node;
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "value"
      ) {
        valueAccess = node;
      }

      if (valueAccess !== undefined) {
        const t = checker.getTypeAtLocation(valueAccess);
        if (isSecretValueType(t)) {
          // The `.value` resolves to a SecretValue. Allowed ONLY when it is the
          // receiver of an audited member call (`.value.bytes()` etc.), OR when
          // it is handed BY REFERENCE into a Buffer-native internal sink whose
          // parameter is typed SecretValue (runTemplate's `secret`, upsertSecret's
          // `value`) — see isByRefSinkHandoff. A bare `.value` reaching a response
          // object (e.g. `return { value: r.value }`) is neither and IS flagged.
          const parent = valueAccess.parent;
          const isAuditedDoor =
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === valueAccess &&
            ALLOWED_MEMBERS.has(parent.name.text);
          const isAuditedByRefSink = isByRefSinkHandoff(valueAccess, checker);
          if (!isAuditedDoor && !isAuditedByRefSink) {
            const { line } = sf.getLineAndCharacterOfPosition(valueAccess.getStart(sf));
            offenders.push(`${rel}:${line + 1}  ${valueAccess.getText(sf)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(
    offenders,
    [],
    `Raw resolved SecretValue read(s) found — read only via .value.bytes() (and dispose):\n${offenders.join("\n")}`,
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
