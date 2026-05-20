import assert from "node:assert/strict";
import test from "node:test";
import { deriveSkillUrl } from "./skill-url.js";

test("deriveSkillUrl handles https://github.com/<o>/<r>.git", () => {
  const url = deriveSkillUrl({ repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles https://github.com/<o>/<r> (no .git suffix)", () => {
  const url = deriveSkillUrl({ repository: { url: "https://github.com/pdumicz/secret-shuttle" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles git+https:// prefix", () => {
  const url = deriveSkillUrl({ repository: { url: "git+https://github.com/pdumicz/secret-shuttle.git" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles github:owner/repo shorthand", () => {
  const url = deriveSkillUrl({ repository: { url: "github:pdumicz/secret-shuttle" } });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl handles repository as a string (npm sugar)", () => {
  const url = deriveSkillUrl({ repository: "github:pdumicz/secret-shuttle" });
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl branch override swaps only the branch segment", () => {
  const url = deriveSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    { branch: "feat/skill-installers" },
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/feat/skill-installers/skills/secret-shuttle/SKILL.md");
});

test("deriveSkillUrl path override swaps only the path segment", () => {
  const url = deriveSkillUrl(
    { repository: { url: "https://github.com/pdumicz/secret-shuttle.git" } },
    { path: "skills/secret-shuttle/OTHER.md" },
  );
  assert.equal(url, "https://raw.githubusercontent.com/pdumicz/secret-shuttle/main/skills/secret-shuttle/OTHER.md");
});

test("deriveSkillUrl throws repository_field_missing when repository is absent", () => {
  assert.throws(
    () => deriveSkillUrl({}),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "repository_field_missing",
  );
});

test("deriveSkillUrl throws repository_field_missing when repository.url is empty", () => {
  assert.throws(
    () => deriveSkillUrl({ repository: { url: "" } }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "repository_field_missing",
  );
});

test("deriveSkillUrl throws when repository host is not github", () => {
  assert.throws(
    () => deriveSkillUrl({ repository: { url: "https://gitlab.com/pdumicz/secret-shuttle.git" } }),
    (e: unknown) => e instanceof Error && (e as { code?: string }).code === "unsupported_repository_host",
  );
});
