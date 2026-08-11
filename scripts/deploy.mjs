#!/usr/bin/env node
// Deploy with provenance stamped in.
//
// Until now there was no link between a Cloudflare version id and a git sha, so
// "the deployed worker is this commit" rested on a clean tree plus the belief
// that src had not changed since. That claim was made repeatedly on 2026-08-09
// and could never be checked; it is batch-two item 2.
//
// The sha is passed as a deploy-time --var rather than written into
// wrangler.jsonc (gitignored here, so it cannot carry committed values) or into
// a generated source file (which would either dirty the tree on every deploy or
// break a fresh clone's typecheck). --var attaches it to the deployment itself,
// which is exactly the thing being identified.
//
// dirty=true when the tree has uncommitted changes: the deployed bytes are then
// NOT the named commit, and /health says so rather than implying otherwise.

import { execFileSync, spawnSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let sha = "unknown";
let dirty = false;
try {
  sha = git(["rev-parse", "HEAD"]);
  dirty = git(["status", "--porcelain"]).length > 0;
} catch {
  // Deploying from something that is not a git checkout is allowed, but it is
  // recorded as unknown rather than guessed.
  console.warn("deploy: not a git checkout, provenance will report sha=unknown");
}

const builtAt = new Date().toISOString();
const args = [
  "wrangler",
  "deploy",
  "--var",
  `BUILD_SHA:${sha}`,
  "--var",
  `BUILD_DIRTY:${dirty ? "true" : "false"}`,
  "--var",
  `BUILT_AT:${builtAt}`,
  ...process.argv.slice(2),
];

console.log(`deploy: sha=${sha.slice(0, 8)} dirty=${dirty} builtAt=${builtAt}`);
if (dirty) {
  console.warn("deploy: WORKING TREE IS DIRTY. /health will report dirty=true; the deployed bytes are not the named commit.");
}

const result = spawnSync("npx", ["--no-install", ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
