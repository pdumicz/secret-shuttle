import { ShuttleError } from "../shared/errors.js";

export interface RepositoryField {
  /** npm allows repository to be a string (shorthand) or an object with `url`. */
  repository?: string | { url?: string };
}

export interface DeriveOpts {
  /** Branch (or ref — same field) to splice into the raw URL. Default: "main". */
  branch?: string;
  /** Path within the repo. Default: "skills/secret-shuttle/SKILL.md". */
  path?: string;
}

const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "skills/secret-shuttle/SKILL.md";

/**
 * Pure helper. Given an npm-style `repository` field, derive the
 * raw.githubusercontent.com URL for the canonical SKILL.md. Throws
 * ShuttleError fail-closed if the field is absent, empty, or points
 * at a non-github host (no silent fall-back to a hardcoded URL).
 */
export function deriveSkillUrl(pkg: RepositoryField, opts: DeriveOpts = {}): string {
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const path = opts.path ?? DEFAULT_PATH;
  const raw = typeof pkg.repository === "string"
    ? pkg.repository
    : (pkg.repository?.url ?? "");
  if (raw === "" || raw === undefined) {
    throw new ShuttleError(
      "repository_field_missing",
      "package.json is missing a repository field — cannot derive skill URL.",
    );
  }
  let normalized = raw.replace(/^git\+/, "").replace(/\.git$/, "");
  const shorthand = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalized);
  let owner: string;
  let repo: string;
  if (shorthand !== null) {
    owner = shorthand[1] ?? "";
    repo = shorthand[2] ?? "";
  } else {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(normalized);
    if (m === null) {
      throw new ShuttleError(
        "unsupported_repository_host",
        `repository.url must be a github.com URL; got: ${raw}`,
      );
    }
    owner = m[1] ?? "";
    repo = m[2] ?? "";
  }
  if (owner === "" || repo === "") {
    throw new ShuttleError(
      "repository_field_missing",
      `repository.url did not parse to owner/repo; got: ${raw}`,
    );
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}
