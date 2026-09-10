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

// Everything that could be a caller: the rest of src/, both test suites, and
// scripts/. The whole point of the ruling is that "no caller" is a claim about
// THREE places, and a scan that read one of them is how two live exports were
// declared dead.
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

function hasCallerElsewhere(name: string, ownFile: string): boolean {
  const re = new RegExp(`\\b${name}\\b`);
  if (sourceFiles().some((f) => f.name !== ownFile && re.test(f.text))) return true;
  return READERS.some((f) => re.test(f.text));
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
const KNOWN_SUSPECTS = [
  "src/github.ts: assertRepoArg",
  "src/github.ts: workflowRunsForBranch",
  "src/headers.ts: REPORTING_ENDPOINTS",
  "src/improve-anthropic.ts: clientFor",
  "src/improve-anthropic.ts: costOf",
  "src/improve-run.ts: DEFAULT_RUN_PROMPT",
  "src/improve-run.ts: verifyTaskDocument",
  "src/improve-schema.ts: ATTEMPT_STATUSES",
  "src/improve-scorer.ts: BACKUP_BUCKET_NAME",
  "src/improve-scorer.ts: BACKUP_DUMP_PREFIX",
  "src/improve-scorer.ts: HOLDOUT_BUCKET_NAME",
  "src/improve-scorer.ts: HOLDOUT_CREDENTIAL_TTL_SECONDS",
  "src/store-probe.ts: HEALTH_PROBE_NS",
  "src/store-probe.ts: HEALTH_PROBE_PATH",
  "src/store-probe.ts: HEALTH_PROBE_TERM",
];

test("the set of exports with no caller anywhere is exactly the reviewed list", () => {
  const declared = new Set(declaredByHoldout());
  const suspects: string[] = [];
  for (const { file, name } of exportsOfSrc()) {
    if (hasCallerElsewhere(name, file)) continue;
    // The manifest is the third place to look, and it is the one that cost an
    // anchor when it did not exist.
    if (declared.has(name)) continue;
    suspects.push(`src/${file}: ${name}`);
  }
  assert.deepEqual(
    suspects.sort(),
    [...KNOWN_SUSPECTS].sort(),
    `the no-caller set moved. New entries are unreviewed; missing ones were removed or gained a caller.\n` +
      `Before deleting any of these, score a branch without it: the holdout is a consumer no scan here can see, ` +
      `and that is exactly how seedScoresDoc and hasWideDash were declared dead on 2026-09-07.`
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
      !KNOWN_SUSPECTS.some((s) => s.endsWith(`: ${name}`)),
      `${name} is vouched for by ${MANIFEST} and must not also be listed as a suspect`
    );
  }
});
