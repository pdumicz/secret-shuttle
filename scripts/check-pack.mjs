#!/usr/bin/env node
// Fails if the npm tarball would ship internal plans, source maps, or STALE
// build artifacts (detected via forbidden source markers from removed code).
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FORBIDDEN_PATHS = [/^docs\/superpowers\//, /\.map$/, /\.tsbuildinfo$/, /\.test\.(js|d\.ts)$/];
const FORBIDDEN_MARKERS = ["--confirm-production", "remote-debugging-port"];

const raw = execSync("npm pack --dry-run --json --ignore-scripts", { encoding: "utf8" });
const files = JSON.parse(raw)[0].files.map((f) => f.path.replace(/^package\//, ""));

const badPaths = files.filter((f) => FORBIDDEN_PATHS.some((re) => re.test(f)));
if (badPaths.length > 0) {
  console.error("check-pack: forbidden files in tarball:\n" + badPaths.join("\n"));
  process.exit(1);
}

function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) {
      const txt = readFileSync(p, "utf8");
      for (const m of FORBIDDEN_MARKERS) {
        if (txt.includes(m)) {
          console.error(`check-pack: stale artifact marker "${m}" found in ${p}`);
          process.exit(1);
        }
      }
    }
  }
}
if (!existsSync("dist")) {
  console.error("check-pack: dist/ not found — run npm run build first");
  process.exit(1);
}
walk("dist");
console.log(`check-pack: OK (${files.length} files, no forbidden paths/markers)`);
