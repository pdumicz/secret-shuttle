import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { ShuttleError } from "../shared/errors.js";
import type { AgentTarget } from "./commands/agent.js";

export interface SplitFrontmatterResult {
  data: Record<string, unknown> | null;
  body: string;
}

const FRONTMATTER_INVALID =
  "The bundled SKILL.md frontmatter is missing or malformed (expected a leading `---` block with non-empty single-line string `name` and `description`). Reinstall secret-shuttle.";

/**
 * Split a SKILL.md string into parsed frontmatter `data` and `body`.
 *
 *  - No leading `---` line, or a leading `---` with no matching closing `---`
 *    line → `{ data: null, body: raw }` (treated as "no frontmatter").
 *  - Both fences present but the inner YAML fails to parse OR does not parse
 *    to a plain object → throws ShuttleError("skill_frontmatter_invalid").
 *    A present-but-broken block is a corruption signal, not "absent".
 *  - Otherwise → `{ data, body }`, where body is everything after the closing
 *    fence with leading blank lines trimmed.
 */
export function splitFrontmatter(raw: string): SplitFrontmatterResult {
  const lines = raw.split("\n");
  // NOTE: this repo compiles with `noUncheckedIndexedAccess: true`, so every
  // `lines[i]` is typed `string | undefined`. Bind each element to a checked
  // local before calling `.trim()` (a bare `lines[i].trim()` would not compile
  // and would break Step 4's `npm run build`).
  const first = lines[0];
  if (first === undefined || first.trim() !== "---") {
    return { data: null, body: raw };
  }
  // Find the closing fence: the next line (index >= 1) that is exactly `---`.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() === "---") {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Opening fence with no close — treat as no frontmatter (least surprising).
    return { data: null, body: raw };
  }
  const inner = lines.slice(1, closeIdx).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(inner);
  } catch {
    throw new ShuttleError("skill_frontmatter_invalid", FRONTMATTER_INVALID);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ShuttleError("skill_frontmatter_invalid", FRONTMATTER_INVALID);
  }
  // Body = lines after the closing fence, with leading blank lines trimmed.
  let bodyStart = closeIdx + 1;
  for (let line = lines[bodyStart]; line !== undefined && line.trim() === ""; line = lines[bodyStart]) {
    bodyStart++;
  }
  const body = lines.slice(bodyStart).join("\n");
  return { data: parsed as Record<string, unknown>, body };
}

export function frameSkillForTarget(target: AgentTarget, raw: string): string {
  // Implemented in Task 3.
  void yamlStringify;
  void target;
  void raw;
  throw new ShuttleError("skill_frontmatter_invalid", FRONTMATTER_INVALID);
}
