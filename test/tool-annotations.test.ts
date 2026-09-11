import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFor, TOOL_HINTS } from "../src/tool-annotations.ts";
import { requiredGrant } from "../src/scope.ts";
import { AUTHORITATIVE } from "../src/counts.ts";
import { allSourceText, toolBlocks } from "./source-files.ts";

const CAPSID = AUTHORITATIVE.capsid;

// TOOL ANNOTATIONS ARE DERIVED, NOT DECLARED.
//
// An annotation is a hint a client acts on, so a wrong one is worse than a missing
// one: `readOnlyHint: true` on a tool that writes tells a client it need not ask.
// src/tool-annotations.ts is a cache of two facts that live in the handlers, and
// this file is what keeps it honest, the same relationship src/counts.ts has with
// test/counts.test.ts.
//
// Every scan below fails in BOTH directions, and every one carries a vacuity guard,
// because "0 tools disagreed" and "0 tools were read" are indistinguishable
// otherwise (capsid/conventions.md: pair every content check with a count check).

// A tool is WRITE-GATED iff src/scope.ts says a call needs the write grant.
//
// This used to be read out of the handler text, matching the inline `if (!mayWrite)`
// refusal or the shared repo-write wrapper. The gate moved to one enforcement point
// (the registrar, plus an explicit check in the two action-scoped tools), so the
// handler no longer carries a spelling to match and the requirement is read from the
// artifact that decides it.
//
// It is still DERIVED rather than declared, which is the whole point of this file:
// TOOL_GRANTS is what the registrar enforces at runtime, so a tool whose requirement
// changes there changes its hint here, and test/invariants.test.ts separately proves
// TOOL_GRANTS itself against the handlers (every mutating tool is write-gated, and
// nothing marked read contains mutating SQL). The two files together close the loop
// that reading one artifact against itself would leave open.
const isWriteGated = (tool: string) => requiredGrant(tool) !== "read";

// A write-gated handler is DESTRUCTIVE iff it can overwrite or remove state that
// already exists. Matched by what the handler does, never by its name, so the next
// tool that learns to delete something is caught by this file rather than by an
// incident.
const DESTRUCTIVE = [
  /INSERT INTO documents/i, // an overwrite goes through the same insert as a create
  /\bdocumentUpsert\(/,
  /\bpathMutation\(/,
  /UPDATE namespaces/i,
  /\bdeleteRepoFile\(/,
  /\bdeleteBranch\(/,
  /\bmanagePr\(/,
  /\bwriteRepoFile\(/,
  // The improve loop's two mutating entry points. improveControl writes the mode,
  // the pause key and the budget caps; improveRunManual advances a run, which
  // reverts attempts. Named because the subsystem's writes happen a module away,
  // where an INSERT or a DELETE in this file's own text cannot see them.
  /\bimproveControl\(/,
  /\bimproveRunManual\(/,
  // The work queue's mutating entry points, named for the same reason: the row and
  // document writes happen in src/jobs.ts, a module away from this file's text.
  /\bclaimJob\(/,
  /\bcompleteJob\(/,
  /\bfailJob\(/,
  /\bblockJob\(/,
];

const matches = (body: string, res: RegExp[]) => res.some((re) => re.test(body));

test("the scan finds every tool, so nothing here can pass by reading nothing", () => {
  const blocks = toolBlocks();
  // Derived from src/counts.ts rather than spelled, so the surface moves in one
  // place. Spelled out, every ruled addition broke this test for a reason that had
  // nothing to do with annotations.
  assert.equal(blocks.length, CAPSID.tools, `the tool-block walk found ${blocks.length} registrations`);
  assert.ok(blocks.every((b) => b.body.length > 100), "a zero-length block would make every match below vacuous");
});

test("PLANT: the hint table and the registrations name exactly the same tools", () => {
  const registered = toolBlocks().map((b) => b.name).sort();
  const tabled = Object.keys(TOOL_HINTS).sort();
  assert.deepEqual(tabled, registered, "a tool without an entry, or an entry without a tool, fails here");
});

test("PLANT: every tool is annotated at its registration, from the table and not by hand", () => {
  const unannotated = toolBlocks()
    .filter((b) => !new RegExp(`annotations: hintsFor\\("${b.name}"\\)`).test(b.body))
    .map((b) => b.name);
  assert.deepEqual(unannotated, [], `these tools carry no annotations: ${unannotated.join(", ")}`);
  // And nobody hand-wrote one, which would be the way the table stops being the
  // single place the hints live.
  const inline = [...allSourceText().matchAll(/annotations:\s*\{/g)];
  assert.equal(inline.length, 0, "an inline annotation literal bypasses the table this file checks");
});

test("PLANT: readOnlyHint is exactly the negation of the write gate", () => {
  const writeGated = toolBlocks().filter((b) => isWriteGated(b.name));
  // Vacuity guard. The read half is what is stable: fifteen read tools, and every
  // tool added since has been write-gated, so the gated count is the surface minus
  // fifteen and moves with counts.ts rather than by hand.
  const READ_TOOLS = 15;
  assert.equal(
    writeGated.length,
    CAPSID.tools - READ_TOOLS,
    `the write-gate scan found ${writeGated.length} gated tools, expected ${CAPSID.tools - READ_TOOLS}`
  );

  const wrong: string[] = [];
  for (const block of toolBlocks()) {
    const gated = isWriteGated(block.name);
    const hint = hintsFor(block.name);
    if (hint.readOnlyHint === gated) {
      wrong.push(`${block.name}: write-gated=${gated} but readOnlyHint=${hint.readOnlyHint}`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join("; "));
});

test("PLANT: every write-gated tool declares readOnlyHint false", () => {
  // The same property said the way the audit asked for it, so a reader looking for
  // that sentence finds an assertion rather than an inference.
  const lying = toolBlocks()
    .filter((b) => isWriteGated(b.name))
    .filter((b) => hintsFor(b.name).readOnlyHint !== false)
    .map((b) => b.name);
  assert.deepEqual(lying, [], `these write-gated tools claim to be read-only: ${lying.join(", ")}`);
});

test("PLANT: every mutating tool declares destructiveHint true", () => {
  const mutating = toolBlocks().filter((b) => isWriteGated(b.name) && matches(b.body, DESTRUCTIVE));
  assert.ok(mutating.length >= 10, `the destructive scan found only ${mutating.length} mutating tools; it is broken`);
  const understated = mutating.filter((b) => hintsFor(b.name).destructiveHint !== true).map((b) => b.name);
  assert.deepEqual(understated, [], `these tools can overwrite or remove and do not say so: ${understated.join(", ")}`);
});

test("PLANT: no read-only tool claims to be destructive, and no additive tool overstates", () => {
  // The innocent case. A guard that also fires on code doing nothing wrong gets
  // deleted rather than fixed, so the negative direction is asserted too.
  const overstated = toolBlocks()
    .filter((b) => !matches(b.body, DESTRUCTIVE))
    .filter((b) => hintsFor(b.name).destructiveHint === true)
    .map((b) => b.name);
  assert.deepEqual(overstated, [], `these tools claim to be destructive and mutate nothing: ${overstated.join(", ")}`);
  for (const block of toolBlocks()) {
    if (hintsFor(block.name).readOnlyHint) {
      assert.equal(hintsFor(block.name).destructiveHint, false, `${block.name} is read-only and cannot be destructive`);
    }
  }
});

test("an unknown tool fails CLOSED rather than claiming to be safe", () => {
  const unknown = hintsFor("a_tool_that_does_not_exist");
  assert.equal(unknown.readOnlyHint, false, "a tool with no entry must not be advertised as read-only");
  assert.equal(unknown.destructiveHint, true);
  // And the prototype-chain trap that bit AUTHORITATIVE on 2026-09-06.
  const constructorLookup = hintsFor("constructor");
  assert.equal(typeof constructorLookup, "object");
  assert.equal(constructorLookup.readOnlyHint, false);
  assert.equal(constructorLookup.destructiveHint, true);
});

test("no hint ships that this file does not derive", () => {
  // openWorldHint was written here and removed the same day. The obvious
  // derivation, "the handler calls into src/github.ts", is one hop deep, and it
  // disagreed with the table twice on first run: register_namespace and
  // update_namespace reach GitHub through repoTokenOk, and improve_run dispatches
  // a workflow through improve-run.ts and so read as closed-world. idempotentHint
  // has no scan at all. Neither ships.
  for (const name of Object.keys(TOOL_HINTS)) {
    assert.deepEqual(
      Object.keys(TOOL_HINTS[name]).sort(),
      ["destructiveHint", "readOnlyHint"],
      `${name} carries a hint nothing in this file derives`
    );
  }
});
