// Re-copy the byte-identical scorer surface from this repo to the four roster repos.
//
// WHY THIS EXISTS. The score job and scripts/improve-report.mjs are byte-identical
// across all five roster repos, and nothing enforced that. On 2026-09-10 a comment
// pass (PR #10) rewrote both here and the four copies silently diverged; the same
// pass also deleted four executable diagnostics from the score job, which is why a
// "comment sync" is not a thing anyone should do by hand.
//
// CROSS-REPO IDENTITY CANNOT BE ASSERTED BY AN OFFLINE TEST. The other four repos
// are not on this disk in CI, so test/sync-scorer.test.ts checks the half that can
// run here (the marker is unique, the split is lossless, the hash is stable) and
// the dry run below checks the half that needs the clones.
//
//   node scripts/sync-scorer.mjs           report what would change, write nothing
//   node scripts/sync-scorer.mjs --apply   write the files into each clone
//
// It stops at the working tree on purpose. Branch, commit, push and PR are the
// human's gate: merging these repos deploys them.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const MARKER = "BYTE-IDENTICAL BELOW THIS LINE";
export const WORKFLOW = ".github/workflows/improve-score.yml";
export const REPORT = "scripts/improve-report.mjs";

const DEV = join(import.meta.dirname, "..", "..");
const SOURCE = { dir: "capsid-mcp", ref: "master" };
const TARGETS = [
  { dir: "dustinedwards-info", ref: "main" },
  { dir: "foxhound", ref: "main" },
  { dir: "foxing", ref: "main" },
  { dir: "germomics", ref: "main" },
];

/**
 * The shared block is the marker line to end of file. The marker must occur
 * EXACTLY ONCE: zero means the file is not the shape this copier assumes, and two
 * means the split point is a guess. Either way it refuses rather than picking one.
 * @param {string} text
 * @param {string} label
 * @returns {{ head: string, tail: string }}
 */
export function splitBlock(text, label) {
  const lines = normalize(text).split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes(MARKER)) hits.push(i);
  });
  if (hits.length !== 1) {
    throw new Error(`${label}: marker found ${hits.length} times, expected exactly 1`);
  }
  return { head: lines.slice(0, hits[0]).join("\n"), tail: lines.slice(hits[0]).join("\n") };
}

/**
 * All five repos commit LF (`git ls-files --eol` reports i/lf w/lf, and
 * .gitattributes pins `* text=auto eol=lf`). Normalizing here means the hash is a
 * property of the content rather than of which host checked the file out.
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

/**
 * @param {string} text
 * @returns {string}
 */
export function blockHash(text) {
  return createHash("sha256").update(normalize(text), "utf8").digest("hex");
}

/**
 * Read a path from a repo's committed ref, never its working tree: a clone is not
 * the repo, and a dirty tree is not what the other repos will receive.
 * @param {string} dir
 * @param {string} ref
 * @param {string} path
 * @returns {string}
 */
function show(dir, ref, path) {
  return execFileSync("git", ["-C", join(DEV, dir), "show", `${ref}:${path}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function main() {
  const apply = process.argv.includes("--apply");
  const short = (/** @type {string} */ s) => blockHash(s).slice(0, 16);

  const srcWorkflow = splitBlock(show(SOURCE.dir, SOURCE.ref, WORKFLOW), `${SOURCE.dir} ${WORKFLOW}`);
  const srcReport = normalize(show(SOURCE.dir, SOURCE.ref, REPORT));

  console.log(`source ${SOURCE.dir}@${SOURCE.ref}`);
  console.log(`  score block  ${short(srcWorkflow.tail)}  ${srcWorkflow.tail.split("\n").length} lines`);
  console.log(`  report       ${short(srcReport)}  ${srcReport.split("\n").length} lines\n`);

  let changed = 0;
  for (const t of TARGETS) {
    const cur = splitBlock(show(t.dir, t.ref, WORKFLOW), `${t.dir} ${WORKFLOW}`);
    const curReport = normalize(show(t.dir, t.ref, REPORT));
    const wfDrift = short(cur.tail) !== short(srcWorkflow.tail);
    const rpDrift = short(curReport) !== short(srcReport);

    console.log(`${t.dir}@${t.ref}`);
    console.log(`  score block  ${short(cur.tail)} -> ${short(srcWorkflow.tail)}  ${wfDrift ? "CHANGES" : "identical"}`);
    console.log(`  report       ${short(curReport)} -> ${short(srcReport)}  ${rpDrift ? "CHANGES" : "identical"}`);
    if (wfDrift || rpDrift) changed++;
    if (!apply) continue;

    // The target keeps its own build job (everything above the marker) and takes
    // the source's block verbatim. Only the block below the marker is shared.
    if (wfDrift) writeFileSync(join(DEV, t.dir, WORKFLOW), `${cur.head}\n${srcWorkflow.tail}`, "utf8");
    if (rpDrift) writeFileSync(join(DEV, t.dir, REPORT), srcReport, "utf8");
    if (wfDrift || rpDrift) console.log("  written to the working tree");
  }

  console.log(
    apply
      ? `\n${changed} repo(s) written. Nothing committed or pushed.`
      : `\n${changed} repo(s) would change. Dry run: nothing written.`
  );
}

if (process.argv[1] && process.argv[1].endsWith("sync-scorer.mjs")) main();
