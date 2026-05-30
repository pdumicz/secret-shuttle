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
    for (const raw of (m[1] ?? "").split(/\s+/)) {
      const tok = cleanToken(raw);
      if (tok === null) break; // non-argument boundary (prose / comment) → stop
      if (tok === "") continue; // dropped punctuation (e.g. a lone `\`)
      tokens.push(tok);
    }
    if (tokens.length > 0) invocations.push(tokens);
  }
  return invocations;
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
interface CmdOption { long?: string | null; short?: string | null; required?: boolean; optional?: boolean }
interface CmdInternals {
  registeredArguments: RegisteredArg[];
  options: CmdOption[];
  _allowUnknownOption?: boolean;
}
const internals = (c: Command): CmdInternals => c as unknown as CmdInternals;
// A `--flag <value>` / `--flag [value]` option consumes the following token as
// its value; a boolean `--flag` does not. Commander records this on the option.
const takesValue = (o: CmdOption): boolean => o.required === true || o.optional === true;

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
 *  - trailing non-option tokens are checked against declared positional ARITY: a
 *    command with N non-variadic positionals accepts at most N of them; a variadic
 *    positional accepts the rest. A command with zero positionals accepts none.
 *  - declared positional MINIMUM: a command with N required `<positional>`s must
 *    receive at least N (so `agent install`, `template run`, `secrets delete` fail
 *    when their required positional is missing, not just when extras are supplied).
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
      // Skip a value-bearing option's value token so it is not miscounted as a
      // positional (e.g. `secrets list --env production`: `production` is --env's value).
      if (!inlineValue && takesValue(opt) && i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-")) {
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
  return { ok: true, resolvedPath, reason: "" };
}
