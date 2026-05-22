import { ShuttleError } from "../../shared/errors.js";
import { parseSecretRef } from "../../shared/refs.js";

export interface EnvFileEntry {
  key: string;
  /**
   * For refs (isRef=true): the CANONICAL ref string (parseSecretRef.ref).
   * For literals (isRef=false): the raw value (unquoted if double-quoted),
   *   without shell expansion.
   */
  value: string;
  /** True iff `value` parses successfully via parseSecretRef. */
  isRef: boolean;
}

export interface EnvFileParseResult {
  entries: EnvFileEntry[];
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Strict dotenv-like parser. Spec §5.3 rules:
 *   - One KEY=VALUE per line.
 *   - Blank lines and `#`-prefixed comments ignored.
 *   - Keys: [A-Z_][A-Z0-9_]* (POSIX env var convention).
 *   - Values: literal. Double quotes around value are stripped but backslash
 *     escapes are NOT expanded. No `${VAR}` shell expansion.
 *   - A value is recognized as an `ss://` ref only if the ENTIRE value parses
 *     via the canonical parseSecretRef helper — that's the SINGLE source of
 *     truth for ref grammar (NAME_RE allows mixed-case, dots, dashes, etc.).
 *     Partial substrings stay literal.
 *   - When the value is a ref, it's stored CANONICALIZED (e.g. 'prod' → 'production').
 *
 * Errors: throws ShuttleError("env_file_parse_error", "<line N>: <reason>")
 * for any malformed line.
 */
export function parseEnvFile(content: string): EnvFileParseResult {
  const entries: EnvFileEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      throw new ShuttleError(
        "env_file_parse_error",
        `line ${lineNum}: missing '=' in env-file entry`,
      );
    }
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      throw new ShuttleError(
        "env_file_parse_error",
        `line ${lineNum}: invalid key '${key}' (must match [A-Z_][A-Z0-9_]*)`,
      );
    }
    // Strip surrounding double-quotes (do NOT expand backslash escapes).
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // Ref detection. Three cases:
    //   (a) Value does NOT start with `ss://` → literal (no further check).
    //   (b) Value starts with `ss://` AND parses → store CANONICAL ref.
    //   (c) Value starts with `ss://` AND fails to parse → THROW env_file_parse_error.
    //
    // Case (c) is fail-closed by design: an unparseable full-value `ss://`
    // is almost always a typo (trailing slash, lowercase env shorthand that
    // doesn't canonicalize, missing name, etc.). Silently passing the raw
    // string to the child env makes the failure mode "child sees the literal
    // string 'ss://...' as a credential" — harder to diagnose than a parse
    // error at load time.
    //
    // Substring occurrences (e.g. `MOTD=visit ss://...`) stay literal — only
    // entire-value `ss://` triggers strict validation.
    if (value.startsWith("ss://")) {
      try {
        const canonical = parseSecretRef(value).ref;
        entries.push({ key, value: canonical, isRef: true });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new ShuttleError(
          "env_file_parse_error",
          `line ${lineNum}: value for '${key}' looks like an ss:// ref but failed to parse: ${reason}`,
        );
      }
    } else {
      entries.push({ key, value, isRef: false });
    }
  }
  return { entries };
}
