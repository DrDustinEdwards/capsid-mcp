// THE DETERMINISTIC PATH GUARD, FOR THE SUBSCRIPTION-MODE DRIVER (residual 10).
//
// In API mode the Worker runs pathMonitor() over an attempt's changed paths and
// reverts anything touching a test, a workflow, a lockfile or the loop's own
// source. Subscription mode never enters that code: the driver is a Claude Code
// session on a laptop with five clones and local credentials, which is the mode
// with the MOST reach and had the least checking.
//
// This is that guard, runnable from a clone with no install. It does NOT carry
// its own copy of the pattern list, which is the whole point: the driver fetches
// `protected_paths` from improve_status and passes it in, so the rules it applies
// are the rules the Worker holds and cannot drift from them. A copy here would be
// correct on the day it was written and wrong the first time a pattern was added.
//
// Usage, from the driver:
//
//   git diff --name-only <base>..HEAD > changed.txt
//   node scripts/path-guard.mjs protected.json changed.txt
//
// protected.json is the `protected_paths` array improve_status returned, verbatim.
// Exit 0 means no changed path is protected. Exit 1 means at least one is, and
// every hit is printed with the reason the Worker gives for it. Exit 2 means the
// guard could not run, which is NOT a pass.

import { readFileSync } from "node:fs";

// Returns the hits, or throws. An EMPTY LIST IS A REFUSAL, not an all-clear: a
// driver whose improve_status call failed, or which passed the wrong field, must
// not conclude that nothing is protected. Fail closed, as everything else here
// does.
export function checkPaths(served, paths) {
  if (!Array.isArray(served) || served.length === 0) {
    throw new Error(
      "no protected paths were supplied. Pass the `protected_paths` array from improve_status; an empty list is a failed fetch, not an all-clear."
    );
  }
  const patterns = served.map((entry) => {
    if (typeof entry?.pattern !== "string") throw new Error(`a protected path entry carries no pattern: ${JSON.stringify(entry)}`);
    return { regexp: new RegExp(entry.pattern, entry.flags ?? ""), why: entry.why ?? "protected" };
  });
  const hits = [];
  for (const path of paths) {
    for (const { regexp, why } of patterns) {
      if (regexp.test(path)) {
        hits.push({ path, why });
        break;
      }
    }
  }
  return hits;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (invokedDirectly) {
  const [servedFile, changedFile] = process.argv.slice(2);
  if (!servedFile || !changedFile) {
    console.error("usage: node scripts/path-guard.mjs <protected_paths.json> <changed-paths.txt>");
    process.exit(2);
  }
  try {
    const served = JSON.parse(readFileSync(servedFile, "utf8"));
    const paths = readFileSync(changedFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      console.log("path guard: the attempt changed no files");
      process.exit(0);
    }
    const hits = checkPaths(Array.isArray(served) ? served : served.protected_paths, paths);
    if (hits.length === 0) {
      console.log(`path guard: ${paths.length} changed path(s), none protected`);
      process.exit(0);
    }
    for (const hit of hits) console.error(`PROTECTED ${hit.path} (${hit.why})`);
    console.error(`path guard REFUSED this attempt: ${hits.length} protected path(s). An attempt may not edit what measures it.`);
    process.exit(1);
  } catch (e) {
    console.error(`path guard could not run: ${e.message}`);
    process.exit(2);
  }
}
