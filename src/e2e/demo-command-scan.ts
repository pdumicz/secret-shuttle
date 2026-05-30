import type { Command } from "commander";

/**
 * Extract every `secret-shuttle …` invocation from raw HTML/text, returning one
 * token array per invocation (the command path plus ALL its arg/option tokens —
 * including those on backslash-continuation lines, which the demo uses for
 * multi-flag commands like Scene 5's `secrets set`). HTML tags are stripped and a
 * few entities decoded first; then trailing-`\` line continuations are folded
 * into a single logical line BEFORE matching, so continuation-line options
 * (`--name`, `--kind`, …) are part of the invocation and get validated against
 * the resolved command's option metadata rather than being silently invisible.
 *
 * Shell-quoted spans (double- or single-quoted) are grouped into one opaque token
 * (the surrounding quotes are removed). This faithfully models shell tokenization
 * for multi-word option values like `--success-text "Environment Variable Added"`.
 *
 * Conservative by design — the demo also embeds `secret-shuttle` in prose,
 * filenames, and npm output:
 *  - Triggers only on `secret-shuttle` followed by whitespace, so `secret-shuttle.yml`,
 *    `secret-shuttle@0.1.1`, `secret-shuttle.` (prose) and `… secret-shuttle)` never match.
 *  - Token collection stops at the first non-argument-shaped token (e.g. a `#`
 *    comment or a prose word with punctuation); lone punctuation such as a trailing
 *    `\` is dropped. The command PATH always leads, so it survives intact.
 */
export function extractShuttleInvocations(rawText: string): string[][] {
  const text = rawText
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    // Fold shell line-continuations: a `\` at end-of-line (optionally followed by
    // trailing whitespace) joins the next line into the same logical invocation.
    // The demo renders each continuation as its own DOM node, so after tag
    // stripping the `\` is followed by whitespace/newline — this stitches the
    // `secrets set \  --name … \  --kind …` form back into one line.
    .replace(/\\[ \t]*\r?\n/g, " ");

  const invocations: string[][] = [];
  const re = /secret-shuttle[ \t]+([^\r\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tokens: string[] = [];
    for (const { text: raw, quoted } of splitArgs(m[1] ?? "")) {
      if (quoted) {
        // A shell-quoted span (e.g. `--success-text "Environment Variable Added"`) is
        // kept verbatim as one opaque value: it bypasses cleanToken's argument-shape
        // gate so internal spaces survive. The resolver still re-validates the full
        // token sequence against the registry, so this never launders drift.
        if (raw !== "") tokens.push(raw);
        continue;
      }
      const tok = cleanToken(raw);
      if (tok === null) break; // non-argument boundary (prose / comment) → stop
      if (tok === "") continue; // dropped punctuation (e.g. a lone `\`)
      tokens.push(tok);
    }
    if (tokens.length > 0) invocations.push(tokens);
  }
  return invocations;
}

// Split a shell-ish argument line into tokens, grouping double- and single-quoted
// spans into a single token (the surrounding quotes are removed). A quoted token is
// flagged so the caller treats it as an opaque value: it may contain spaces or
// punctuation and is never a command name or option flag, so it bypasses the
// argument-shape gate. Unquoted runs split on whitespace. An unterminated quote
// consumes the rest of the line (shell-ish, good enough for our inputs).
function splitArgs(line: string): Array<{ text: string; quoted: boolean }> {
  const out: Array<{ text: string; quoted: boolean }> = [];
  let buf = "";
  let quoted = false;   // did the current token include any quoted span?
  let started = false;  // are we currently accumulating a token?
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { out.push({ text: buf, quoted }); buf = ""; quoted = false; started = false; }
      continue;
    }
    buf += ch;
    started = true;
  }
  if (started) out.push({ text: buf, quoted });
  return out;
}

// Returns the cleaned token, "" to skip it, or null to STOP collecting this invocation.
function cleanToken(raw: string): string | null {
  const t = raw.replace(/^[("'`]+/, "").replace(/[)"'`,;\\]+$/, "");
  if (t === "") return ""; // was pure punctuation (lone `\`, `(`, …)
  if (t.startsWith("#")) return null; // shell comment → stop
  if (t.startsWith("-")) return t; // option token → keep
  if (/^[A-Za-z0-9][A-Za-z0-9._:/@=-]*$/.test(t)) return t; // command / positional / value
  return null; // prose word with punctuation, etc. → stop
}

export interface PathResult {
  ok: boolean;
  resolvedPath: string[];
  reason: string;
}

// Minimal structural views over Commander internals we read (no public getters).
// `required` is true for a `<name>` positional and false for a `[name]` one
// (Commander records it on the Argument). We read it to enforce the required
// MINIMUM, not just the arity maximum.
interface RegisteredArg { _name: string; variadic: boolean; required: boolean }
// `required`/`optional` describe whether the option CONSUMES a value token
// (`--flag <value>` / `--flag [value]`); `mandatory` (set by `requiredOption()`)
// describes whether the option must be SUPPLIED at all. They are independent:
// `--source <source>` takes a value but is not mandatory.
interface CmdOption { long?: string | null; short?: string | null; required?: boolean; optional?: boolean; mandatory?: boolean }
interface CmdInternals {
  registeredArguments: RegisteredArg[];
  options: CmdOption[];
  _allowUnknownOption?: boolean;
}
const internals = (c: Command): CmdInternals => c as unknown as CmdInternals;
// A `--flag <value>` (required value) consumes the following token; a boolean
// `--flag` does not. A `--flag [value]` (optional value) MAY consume the next
// token but only if it is not itself an option. Commander records this on the option.
const takesValue = (o: CmdOption): boolean => o.required === true || o.optional === true;
// A `--flag <value>` REQUIRES its value (Commander errors if it is missing);
// a `--flag [value]` does not. Only the required-value form makes a dangling
// flag (end-of-line, or followed by another option) a hard error.
const requiresValue = (o: CmdOption): boolean => o.required === true;

// Walk the registered subcommand tree as far as the leading non-option tokens go.
// Returns the resolved leaf and the index of the first token it did NOT consume.
function walkPath(start: Command, tokens: string[], from: number): { node: Command; next: number; path: string[] } {
  let node: Command = start;
  const path: string[] = [];
  let i = from;
  for (; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("-")) break;
    const sub = node.commands.find((c) => c.name() === tok || c.aliases().includes(tok));
    if (!sub) break;
    node = sub;
    path.push(tok);
  }
  return { node, next: i, path };
}

/**
 * Resolve the LONGEST registered command path for a token sequence, then VALIDATE
 * the remaining tokens against the resolved command's Commander metadata so the
 * guard actually catches drift instead of waving everything through:
 *  - consumed nothing → leading token is not a top-level command (e.g. `doctor`) → invalid.
 *  - `help <args…>` is special: its variadic positional is itself a COMMAND PATH,
 *    so the trailing tokens are re-resolved as a path from the program root. This
 *    is what stops `secret-shuttle help doctor` (a removed verb laundered through
 *    `help`) from silently passing.
 *  - option tokens (`-…`) are validated by name against the command's registered
 *    options (long/short), with `--help`/`-h` always allowed and any option accepted
 *    when the command opts into `allowUnknownOption()` (e.g. the `bootstrap` stub).
 *  - a `--flag <value>` whose value is MISSING (the flag ends the line or is
 *    immediately followed by another option) is rejected, mirroring Commander's
 *    "option argument missing" error (e.g. a trailing `secrets list --env`).
 *  - trailing non-option tokens are checked against declared positional ARITY: a
 *    command with N non-variadic positionals accepts at most N of them; a variadic
 *    positional accepts the rest. A command with zero positionals accepts none.
 *  - declared positional MINIMUM: a command with N required `<positional>`s must
 *    receive at least N (so `agent install`, `template run`, `secrets delete` fail
 *    when their required positional is missing, not just when extras are supplied).
 *  - MANDATORY options: every `requiredOption()` (Commander `mandatory`) must be
 *    supplied, so a bare `secret-shuttle import` / `secrets set` / `inject-submit`
 *    (each missing a required `--flag`) is rejected rather than greenlit.
 */
export function resolveCommandPath(program: Command, tokens: string[]): PathResult {
  const { node, next, path: resolvedPath } = walkPath(program, tokens, 0);

  if (resolvedPath.length === 0) {
    return { ok: false, resolvedPath, reason: `\`${tokens[0] ?? ""}\` is not a registered command` };
  }

  // `help <command path>` — re-resolve the trailing tokens as a real command path.
  if (node.name() === "help") {
    const rest = tokens.slice(next).filter((t) => !t.startsWith("-"));
    if (rest.length === 0) return { ok: true, resolvedPath, reason: "" };
    const sub = walkPath(program, rest, 0);
    if (sub.path.length === rest.length) return { ok: true, resolvedPath: [...resolvedPath, ...rest], reason: "" };
    return {
      ok: false,
      resolvedPath,
      reason: `\`help ${rest.join(" ")}\` names \`${rest[sub.path.length] ?? rest[0]}\`, which is not a registered command`,
    };
  }

  const meta = internals(node);
  const positionalSlots = meta.registeredArguments.length;
  const hasVariadic = meta.registeredArguments.some((a) => a.variadic);
  const requiredPositionals = meta.registeredArguments.filter((a) => a.required).length;
  let positionalsSeen = 0;
  const seenFlags = new Set<string>();

  for (let i = next; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("-")) {
      if (meta._allowUnknownOption) continue;
      // `--name=value` carries its own value; `--name value` consumes the next token.
      const inlineValue = tok.includes("=");
      const flag = inlineValue ? tok.slice(0, tok.indexOf("=")) : tok;
      if (flag === "--help" || flag === "-h") continue;
      const opt = meta.options.find((o) => o.long === flag || o.short === flag);
      if (!opt) {
        return { ok: false, resolvedPath, reason: `\`${resolvedPath.join(" ")}\` has no option \`${flag}\`` };
      }
      // Record both spellings so the mandatory-options check below recognizes the
      // option regardless of whether the demo wrote its long or short form.
      if (opt.long) seenFlags.add(opt.long);
      if (opt.short) seenFlags.add(opt.short);
      const nextIsValue = i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-");
      // A `--flag <value>` with no value (line ends, or next token is another
      // option) is what Commander rejects as "option argument missing".
      if (!inlineValue && requiresValue(opt) && !nextIsValue) {
        return { ok: false, resolvedPath, reason: `\`${resolvedPath.join(" ")}\` option \`${flag}\` requires a value` };
      }
      // Skip a value-bearing option's value token so it is not miscounted as a
      // positional (e.g. `secrets list --env production`: `production` is --env's value).
      if (!inlineValue && takesValue(opt) && nextIsValue) {
        i++;
      }
      continue;
    }
    // Non-option positional: must fit declared arity (variadic soaks up extras).
    positionalsSeen++;
    if (!hasVariadic && positionalsSeen > positionalSlots) {
      return {
        ok: false,
        resolvedPath,
        reason: `\`${resolvedPath.join(" ")}\` accepts ${positionalSlots} positional argument(s) but got an extra \`${tok}\``,
      };
    }
  }
  // Required MINIMUM: a command with N required `<positional>`s must receive at
  // least N. Without this, `secret-shuttle agent install`, `template run`, or
  // `secrets delete` (each missing its required positional) would pass the guard.
  if (positionalsSeen < requiredPositionals) {
    return {
      ok: false,
      resolvedPath,
      reason: `\`${resolvedPath.join(" ")}\` requires ${requiredPositionals} positional argument(s) but got ${positionalsSeen}`,
    };
  }
  // Mandatory options: a `requiredOption()` that was never supplied is rejected
  // by Commander, so a bare `secret-shuttle import` (missing --env-file) or
  // `inject-submit --success-text …` (missing --ref/--field-handle/--submit-handle)
  // must not pass the guard. Skip when the command accepts unknown options.
  if (!meta._allowUnknownOption) {
    const missing = meta.options.find((o) => o.mandatory === true && !((o.long && seenFlags.has(o.long)) || (o.short && seenFlags.has(o.short))));
    if (missing) {
      return {
        ok: false,
        resolvedPath,
        reason: `\`${resolvedPath.join(" ")}\` requires option \`${missing.long ?? missing.short}\``,
      };
    }
  }
  return { ok: true, resolvedPath, reason: "" };
}
