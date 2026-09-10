import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { holdoutImportsPath, parseImportsManifest } from "../scripts/improve-report.mjs";
import { sourceFiles } from "./source-files.ts";

// WHAT "DEAD" MEANS IN THIS REPO, and the definition cost a broken anchor.
//
// On 2026-09-07 a bloat pass removed `seedScoresDoc` and `hasWideDash` from src/
// as exports with no caller in src/ or test/. The hidden holdout suite imports
// both, and the holdout is structurally invisible to anything that runs here:
// that is its entire point. Master then scored 28 of 30 against an anchor of
// `holdout_pass_rate: min 1.0`, which would have reverted every attempt this
// repo ever made. Scoring a branch with both restored gave 30 of 30.
//
// So the portfolio convention, ruled 2026-09-08 and recorded in
// capsid/conventions.md: **an export is dead only when it has no caller in src/,
// no caller in test/, AND no entry in any improve/holdout/<ns>/imports.txt.**
// That third place is the one no grep could reach, which is why it has to be
// written down rather than derived.
//
// This file is the check. It fails in one direction on purpose: it reports
// exports that look dead, so the next bloat pass has a list it can trust. The
// OTHER direction, a manifest that lists a name the suite does not import, is
// checked in the scorer's Job B, where the suite is actually readable.

const ROOT = join(import.meta.dirname, "..");

// The one namespace whose holdout this repo carries. Read through the shared
// helper so the path convention has a single spelling.
const MANIFEST = holdoutImportsPath("capsid");

function declaredByHoldout(): string[] {
  return parseImportsManifest(readFileSync(join(ROOT, MANIFEST), "utf8"));
}

interface Export {
  file: string;
  name: string;
}

// Every exported binding in src/, by name. Functions, consts and classes; types
// and interfaces are deliberately excluded, because a type has no runtime caller
// to find and removing one is a compile error rather than a silent hole.
function exportsOfSrc(): Export[] {
  const out: Export[] = [];
  for (const file of sourceFiles()) {
    for (const m of file.text.matchAll(/^export (?:async )?(?:function|const|class) ([A-Za-z0-9_]+)/gm)) {
      out.push({ file: file.name, name: m[1] });
    }
  }
  return out;
}

// Everything that could be a caller: the rest of src/, both test suites, and scripts/.
// The ruling is that "no caller" is a claim about THREE places, and a scan that read
// one of them is how two live exports were declared dead.
function otherReaders(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const dir of ["test", "test-integration", "scripts"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!/\.(ts|mts|mjs)$/.test(file)) continue;
      // THIS FILE IS NOT A CALLER. It lists every suspect by name below, so
      // counting itself makes each one look used and the set collapses to empty:
      // a check that passes because it read its own answer.
      if (file === "dead-exports.test.ts") continue;
      out.push({ name: `${dir}/${file}`, text: readFileSync(join(ROOT, dir, file), "utf8") });
    }
  }
  return out;
}

const READERS = otherReaders();

// A BARREL RE-EXPORT IS NOT A CALLER. `export { x } from "./y"` names x in order
// to forward it, not to use it, so counting it hides exactly what this file
// exists to surface: put a module behind a barrel and every symbol under it
// looks called by the barrel. A plain `import { x } from` is left alone, because
// importing a name in order to use it is what a caller does. This lands before
// any barrel exists, where it is a no-op, so the guard is already correct on the
// day one appears.
const RE_EXPORT_FROM = /export\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']+["'];?/g;
const RE_EXPORT_STAR = /export\s+\*(?:\s+as\s+[A-Za-z0-9_]+)?\s+from\s*["'][^"']+["'];?/g;
function withoutReExports(text: string): string {
  return text.replace(RE_EXPORT_FROM, "").replace(RE_EXPORT_STAR, "");
}

function hasCallerElsewhere(name: string, ownFile: string): boolean {
  const re = new RegExp(`\\b${name}\\b`);
  if (sourceFiles().some((f) => f.name !== ownFile && re.test(withoutReExports(f.text)))) return true;
  return READERS.some((f) => re.test(withoutReExports(f.text)));
}

test("the scan finds the exports at all, so nothing here can pass by reading nothing", () => {
  const exported = exportsOfSrc();
  assert.ok(exported.length > 100, `only ${exported.length} exports found across src/; the walk is broken`);
  assert.ok(sourceFiles().length > 20, "src/ walk returned too few files");
});

test("PLANT: the holdout import manifest exists and names the exports it needs", () => {
  const declared = declaredByHoldout();
  assert.ok(declared.length > 0, `${MANIFEST} declares nothing; a manifest nobody fills is a guard nobody has`);
  // Every name it declares must actually BE an export of src/. A manifest naming
  // something that does not exist is a manifest describing a repo that moved on.
  const names = new Set(exportsOfSrc().map((e) => e.name));
  const phantom = declared.filter((n) => !names.has(n));
  assert.deepEqual(phantom, [], `${MANIFEST} names exports that src/ does not have: ${phantom.join(", ")}`);
});

test("PLANT: the two exports the holdout imports are still exported from src", () => {
  // Named, not derived, because these two are the incident. A future pass that
  // removes them fails here with the reason attached rather than at 03:00 with an
  // anchor at 28 of 30.
  const names = new Set(exportsOfSrc().map((e) => e.name));
  for (const name of ["seedScoresDoc", "hasWideDash"]) {
    assert.ok(
      names.has(name),
      `${name} is imported by the hidden holdout suite and must stay exported from src/. ` +
        `Removing it scored 28 of 30 against an anchor of min 1.0 on 2026-09-07.`
    );
    assert.ok(declaredByHoldout().includes(name), `${name} must be listed in ${MANIFEST}`);
  }
});

// THE SUSPECTS, NAMED. Exports with no caller in src/, no caller in test/,
// test-integration/ or scripts/, and no entry in the holdout manifest. Every one
// is a CANDIDATE for removal and none of them is cleared for it: the holdout is a
// consumer no scan here can see, so the only way to clear one is to score a branch
// without it and watch holdout_pass_rate.
//
// Listed rather than counted, and asserted in BOTH directions, which is the whole
// pattern this repo uses for a derived list. A new suspect fails the build the day
// it appears, so it is reviewed while somebody still remembers writing it; and
// removing one means editing this list, which is the moment to ask whether a
// branch was scored.
// KEYED BY EXPORT NAME, NOT BY FILE. The name is what is under review; the file
// holding it is not. Keying on "src/<file>: <name>" turned every module move into
// a apparent change in the no-caller set, and the scorer sandbox runs the DEFAULT
// branch's tests against an attempt's src/, so a move surfaced there as a test
// regression no edit to the attempt could clear. Both directions are still
// asserted, and the failure message still prints where each one currently lives.
const KNOWN_SUSPECTS = [
  "ATTEMPT_STATUSES",
  "BACKUP_BUCKET_NAME",
  "BACKUP_DUMP_PREFIX",
  "DEFAULT_RUN_PROMPT",
  "HEALTH_PROBE_NS",
  "HEALTH_PROBE_PATH",
  "HEALTH_PROBE_TERM",
  "HOLDOUT_BUCKET_NAME",
  "HOLDOUT_CREDENTIAL_TTL_SECONDS",
  "REPORTING_ENDPOINTS",
  "assertRepoArg",
  "clientFor",
  "costOf",
  "verifyTaskDocument",
  "workflowRunsForBranch",
];

// TWO CHECKS, AND NEITHER IS "the set still matches exactly".
//
// The exact-match form was wrong in a way only a module split reveals. Splitting
// a file turns intra-file usage into cross-file usage, so an export used only
// inside one big module legitimately STOPS being caller-less the day that module
// is split: assertRepoArg went from suspect to non-suspect on the 2026-09-10
// split without a line of its own changing. Exact match called that a regression.
// Worse, the scorer sandbox runs the DEFAULT branch's tests against an attempt's
// src/, so that false regression was unfixable from inside the attempt: it scored
// 845 of 846 with nothing actually wrong.
//
// What the guard is for, kept in full and split apart:
//
//   (a) A reviewed name must still be EXPORTED. This is the direction that cost
//       an anchor: on 2026-09-07 seedScoresDoc and hasWideDash were deleted as
//       dead, the hidden holdout imports both, and master scored 28 of 30 against
//       an anchor of min 1.0. Deleting an export is the danger, and this checks it
//       directly rather than inferring it from a set difference.
//   (b) No NEW no-caller export may appear unreviewed, so dead code still fails
//       the build the day it is written, while somebody remembers writing it.
//
// Deliberately NOT checked any more: that a reviewed name is STILL caller-less.
// Gaining a caller is good news and was never a defect.
test("every reviewed suspect is still exported from src/", () => {
  const names = new Set(exportsOfSrc().map((e) => e.name));
  const gone = KNOWN_SUSPECTS.filter((n) => !names.has(n));
  assert.deepEqual(
    gone,
    [],
    `these reviewed exports are no longer exported from src/: ${gone.join(", ")}.
` +
      `An export is dead only with no caller in src/, none in test/, AND no entry in the holdout manifest. ` +
      `The holdout is a consumer no scan here can see: score a branch without it and read holdout_pass_rate ` +
      `before deleting it. That is how seedScoresDoc and hasWideDash were declared dead on 2026-09-07.`
  );
});

test("no new no-caller export appears without review", () => {
  const declared = new Set(declaredByHoldout());
  const reviewed = new Set(KNOWN_SUSPECTS);
  const unreviewed: string[] = [];
  for (const { file, name } of exportsOfSrc()) {
    if (hasCallerElsewhere(name, file)) continue;
    // The manifest is the third place to look, and it is the one that cost an
    // anchor when it did not exist.
    if (declared.has(name)) continue;
    if (reviewed.has(name)) continue;
    unreviewed.push(`${name} (src/${file})`);
  }
  assert.deepEqual(
    unreviewed.sort(),
    [],
    `these exports have no caller in src/, none in test/, test-integration/ or scripts/, and no holdout ` +
      `manifest entry, and are not in the reviewed list: ${unreviewed.join(", ")}. ` +
      `Add them to KNOWN_SUSPECTS after looking, or give them a caller.`
  );
});
test("PLANT: a name in the holdout manifest is never reported as a suspect", () => {
  // The manifest earning its keep. Both incident exports have no caller in src/
  // or test/ either, and only the manifest keeps them off the list above.
  const declared = declaredByHoldout();
  for (const name of declared) {
    const own = exportsOfSrc().find((e) => e.name === name);
    assert.ok(own, `${name} is declared in the manifest and is not an export of src/`);
    assert.ok(
      !KNOWN_SUSPECTS.includes(name),
      `${name} is vouched for by ${MANIFEST} and must not also be listed as a suspect`
    );
  }
});
