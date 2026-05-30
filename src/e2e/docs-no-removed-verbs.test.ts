// src/e2e/docs-no-removed-verbs.test.ts
//
// Burst 6 §1.7 drift-guard. Burst 5 removed the `bootstrap` and `generate`
// verbs, and renamed the setup ritual from `daemon start && unlock` to
// `npx init`. The agent-facing documentation surfaces (the canonical
// SKILL.md, all agents/*.example.md, the magic-path walkthrough, and the
// README) must not silently regress to reference the removed verbs.
//
// IMPORTANT — two token categories, NO section exemption:
//
//   REMOVED_TOKENS — verbs Burst 5 hard-removed (`generate`, `bootstrap`, the
//   `daemon start && unlock` ritual). These no longer exist anywhere and must
//   never appear in any agent-facing doc.
//
//   MOVED_TOKENS — verbs Burst 6 §1.8 found had relocated to the hidden
//   `internal` namespace (`capture`, `blind`, `compare`). A BARE
//   `secret-shuttle capture` / `blind` / `compare` no longer resolves at the
//   top level, so it's forbidden — but the `internal`-prefixed form
//   (`secret-shuttle internal blind end`) and `reveal-capture` are fine, and
//   the regexes are adjacency-based so they pass those by construction (the
//   intervening `internal ` / `reveal-` token breaks the match). The modern
//   agentic verbs (`inject-submit`, `reveal-capture`, `browser mark`,
//   `provision`) are the surface agents should actually use; the docs were
//   rewritten in §1.8 to teach those.
//
// The escape-hatch low-level mechanics in the walkthrough's "Advanced" section
// (`browser start`, `browser mark`, `inject-submit`, `reveal-capture`,
// `template run`) are NOT in either token list, so they pass everywhere by
// construction. This test scans every line of every doc with NO section
// exemption — removed AND bare-moved tokens are forbidden everywhere,
// including below the "Advanced" header. (An earlier draft skipped scanning
// below that header, which would have let a forbidden verb slip through in
// exactly the section the burst is meant to keep honest — that exemption is
// deliberately gone.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../cli/build-program.js";
import { extractShuttleInvocations, resolveCommandPath } from "./demo-command-scan.js";

// Spec §1.7 freezes the contract as the *glob* `agents/*.example.md`, not a
// frozen list. Enumerate the directory at collection time (readdirSync keeps
// the `for`-loop test registration synchronous) so any NEW agent example added
// later is covered by this drift guard automatically — a hardcoded list would
// silently exempt future surfaces, defeating the guard. Matches both
// `*.example.md` (e.g. codex-instructions.example.md) and the `AGENTS.md.example`
// naming variant by requiring the `example` + `md` tokens in either order.
const AGENT_DOCS: string[] = readdirSync(join(process.cwd(), "agents"))
  .filter((f) => /\.example\.md$/.test(f) || /\.md\.example$/.test(f))
  .sort()
  .map((f) => join("agents", f));

const DOCS: string[] = [
  "skills/secret-shuttle/SKILL.md",
  ...AGENT_DOCS,
  "README.md",
  "examples/stripe-to-vercel/walkthrough.md",
  // Burst-7 honesty pass: the demo was the one agent-facing surface NOT scanned,
  // which is exactly why removed `doctor`/`generate` survived here. Now covered.
  "demo/index.html",
];

const REMOVED_TOKENS: Array<{ token: RegExp; what: string }> = [
  { token: /secret-shuttle\s+generate\b/, what: "removed `generate` verb (use `provision --secret`)" },
  { token: /secret-shuttle\s+bootstrap\b/, what: "removed `bootstrap` verb (use `provision`)" },
  { token: /daemon\s+start\s*&&\s*secret-shuttle\s+unlock/, what: "removed `daemon start && unlock` ritual (use `npx secret-shuttle init`)" },
  // Looser `daemon start &&` catches variants that drop the explicit `secret-shuttle unlock`.
  { token: /daemon\s+start\s*&&\s*(?!\s*[\r\n])/, what: "removed `daemon start && ...` ritual (use `npx secret-shuttle init`)" },
  // `doctor` was removed in v0.3.0 (the honesty pass replaced it with `status`).
  // It is in neither MOVED_TOKENS nor caught by the registry path-scan in its BARE
  // prose form (e.g. `<code>doctor</code> first`), since that scanner only sees
  // `secret-shuttle …` invocations. A standalone-word match keeps the prose honest
  // without snagging substrings like "doctored". Case-insensitive (`/i`) so the
  // sentence-initial capitalized form (`Doctor reports …`) — exactly the variant the
  // prior demo text used — is also caught, not just the lowercased `doctor first`.
  { token: /\bdoctor\b/i, what: "removed `doctor` verb (use `secret-shuttle status`)" },
];

// Burst 6 §1.8. Verbs that MOVED to the hidden `internal` namespace. Bare
// top-level invocations no longer resolve — agents must use the modern verb
// (inject-submit / reveal-capture / browser mark) or the `internal` prefix
// for rare manual recovery. The regex matches bare `secret-shuttle <verb>`
// but NOT `secret-shuttle internal <verb>` (because `internal` would sit
// between `secret-shuttle` and the verb, breaking the adjacency the regex
// requires) and NOT `reveal-capture` (the `reveal-` prefix breaks adjacency).
const MOVED_TOKENS: Array<{ token: RegExp; what: string }> = [
  { token: /secret-shuttle\s+capture\b/, what: "`capture` moved under `internal` (use `reveal-capture`, or `internal capture` for manual recovery)" },
  { token: /secret-shuttle\s+blind\b/,   what: "`blind` moved under `internal` (blind mode is daemon-managed inside inject-submit/reveal-capture; use `internal blind end` only for manual recovery)" },
  { token: /secret-shuttle\s+compare\b/, what: "`compare` moved under `internal` (not a primary agent verb; use `internal compare` if truly needed)" },
];

for (const path of DOCS) {
  test(`drift-guard: ${path} contains no removed- or moved-verb tokens`, async () => {
    const fullText = await readFile(join(process.cwd(), path), "utf8");
    const lines = fullText.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const { token, what } of [...REMOVED_TOKENS, ...MOVED_TOKENS]) {
        if (token.test(line)) {
          assert.fail(
            `${path}:${i + 1} contains ${what}\n  Line: ${line.trim()}\n  ` +
              `Burst 5/6 removed or moved this verb. See docs/superpowers/specs/2026-05-29-burst6-vision-polish-design.md §1.`,
          );
        }
      }
    }
  });
}

// Pin the adjacency behavior of MOVED_TOKENS: the bare top-level form is
// flagged, but the `internal`-prefixed form (rare manual recovery) and the
// `reveal-capture` modern verb are not — both break the `secret-shuttle <verb>`
// adjacency the regex requires.
test("MOVED_TOKENS regex matches bare but not internal-prefixed or reveal-capture", () => {
  const captureRe = MOVED_TOKENS.find((t) => t.what.startsWith("`capture`"))!.token;
  const blindRe = MOVED_TOKENS.find((t) => t.what.startsWith("`blind`"))!.token;
  const compareRe = MOVED_TOKENS.find((t) => t.what.startsWith("`compare`"))!.token;

  // Bare top-level invocations MATCH (these are the drift we forbid).
  assert.ok(captureRe.test("secret-shuttle capture --name X"), "bare `capture` should match");
  assert.ok(blindRe.test("secret-shuttle blind end"), "bare `blind end` should match");
  assert.ok(compareRe.test("secret-shuttle compare --ref ss://x"), "bare `compare` should match");

  // `internal`-prefixed forms do NOT match (`internal` breaks adjacency).
  assert.ok(!captureRe.test("secret-shuttle internal capture --name X"), "`internal capture` should NOT match");
  assert.ok(!blindRe.test("secret-shuttle internal blind end"), "`internal blind end` should NOT match");
  assert.ok(!compareRe.test("secret-shuttle internal compare --ref ss://x"), "`internal compare` should NOT match");

  // `reveal-capture` does NOT match (the `reveal-` prefix breaks adjacency).
  assert.ok(!captureRe.test("secret-shuttle reveal-capture --name X"), "`reveal-capture` should NOT match");
});

// Check 2 (Burst-7 honesty pass): every `secret-shuttle …` invocation rendered in
// the demo must resolve to a registered command PATH — not merely a registered
// top-level verb. `doctor` (removed in v0.3.0) is in neither token list above, so
// only a registry-backed path check catches it; the same check catches invalid
// leaf pairings like `secrets generate` or `agent setup claude`. The registry is
// the side-effect-free buildProgram() shared with the CLI entrypoint, so it stays
// self-maintaining as commands are added/removed.
test("demo: every `secret-shuttle …` invocation resolves to a registered command path", async () => {
  const program = buildProgram();
  const html = await readFile(join(process.cwd(), "demo/index.html"), "utf8");
  const invocations = extractShuttleInvocations(html);
  assert.ok(
    invocations.length > 0,
    "expected to extract at least one `secret-shuttle …` invocation from the demo",
  );
  for (const tokens of invocations) {
    const result = resolveCommandPath(program, tokens);
    assert.ok(
      result.ok,
      `demo/index.html renders \`secret-shuttle ${tokens.join(" ")}\` but ${result.reason}. ` +
        `Use a registered command (the registry is buildProgram()).`,
    );
  }
});

// Check 3 (Burst-7 honesty pass): keep the removed install ritual out of Scene 3.
// `secret-shuttle daemon start` and `secret-shuttle unlock` are still REGISTERED
// commands (so Check 2 passes them), and `npm install -g secret-shuttle` is not a
// `secret-shuttle <verb>` form at all (so Check 2 never sees it). Assert Scene 3's
// stage uses `npx secret-shuttle init` and contains none of the old ritual's CLI
// command strings. Scoped to the CLI strings, within Scene 3's stage only, so the
// retained passphrase-window button copy "Create & unlock" is unaffected.
test("demo: Scene 3 install uses `npx secret-shuttle init`, not the removed ritual", async () => {
  const html = await readFile(join(process.cwd(), "demo/index.html"), "utf8");
  const start = html.indexOf('class="scene-stage" data-scene="3"');
  assert.notEqual(start, -1, "Scene 3 stage block not found in demo/index.html");
  const end = html.indexOf('class="scene-stage" data-scene="4"', start);
  const scene3Raw = html.slice(start, end === -1 ? undefined : end);

  // Match against the RENDERED stage text, not raw markup: strip tags (collapsing
  // each to a single space) and decode the few entities the demo uses. Otherwise a
  // future split of `secret-shuttle` and `daemon start` across <span>s would render
  // the old ritual while this regex — anchored on raw HTML — silently missed it.
  const scene3 = scene3Raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");

  assert.match(scene3, /npx\s+secret-shuttle\s+init/, "Scene 3 must show `npx secret-shuttle init`");

  const forbidden: Array<{ re: RegExp; what: string }> = [
    { re: /npm\s+install\s+-g\s+secret-shuttle/, what: "`npm install -g secret-shuttle`" },
    { re: /secret-shuttle\s+daemon\s+start/, what: "`secret-shuttle daemon start`" },
    { re: /secret-shuttle\s+unlock/, what: "`secret-shuttle unlock`" },
  ];
  for (const { re, what } of forbidden) {
    assert.ok(
      !re.test(scene3),
      `Scene 3 must not contain the removed install ritual ${what} — use 'npx secret-shuttle init' instead.`,
    );
  }
});
