import assert from "node:assert/strict";
import { test } from "node:test";
import { hintsFor, TOOL_HINTS } from "../src/tool-annotations.ts";
import { sourceFile } from "./source-files.ts";

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

const SERVER = sourceFile("server.ts");

interface ToolBlock {
  name: string;
  body: string;
}

// The same block-splitting shape test/mutation-guard-coverage.test.ts uses. A tool
// block runs from its registration to the next one.
function toolBlocks(): ToolBlock[] {
  const starts = [...SERVER.matchAll(/server\.registerTool\(\s*\n\s*"([a-z_]+)"/g)];
  return starts.map((m, i) => ({
    name: m[1],
    body: SERVER.slice(m.index ?? 0, i + 1 < starts.length ? starts[i + 1].index : SERVER.length),
  }));
}

// A handler is write-gated iff it reaches the operator write grant. Two spellings,
// both matched by shape: the inline refusal, and the shared repo-write wrapper that
// begins with the same refusal.
const WRITE_GATE = [/if \(!mayWrite\) return fail\(DENIED\)/, /\bguardedWrite\(/];

// A write-gated handler is DESTRUCTIVE iff it can overwrite or remove state that
// already exists. Matched by what the handler does, never by its name, so the next
// tool that learns to delete something is caught by this file rather than by an
// incident.
const DESTRUCTIVE = [
  /INSERT INTO documents/i, // an overwrite goes through the same insert as a create
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
];

const matches = (body: string, res: RegExp[]) => res.some((re) => re.test(body));

test("the scan finds all thirty tools, so nothing here can pass by reading nothing", () => {
  const blocks = toolBlocks();
  assert.equal(blocks.length, 30, `the tool-block walk found ${blocks.length} registrations`);
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
  const inline = [...SERVER.matchAll(/annotations:\s*\{/g)];
  assert.equal(inline.length, 0, "an inline annotation literal bypasses the table this file checks");
});

test("PLANT: readOnlyHint is exactly the negation of the write gate", () => {
  const writeGated = toolBlocks().filter((b) => matches(b.body, WRITE_GATE));
  // Vacuity guard with a floor derived from the surface split recorded in
  // capsid/core.md: fifteen read, fifteen write-gated.
  assert.equal(writeGated.length, 15, `the write-gate scan found ${writeGated.length} gated tools, expected 15`);

  const wrong: string[] = [];
  for (const block of toolBlocks()) {
    const gated = matches(block.body, WRITE_GATE);
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
    .filter((b) => matches(b.body, WRITE_GATE))
    .filter((b) => hintsFor(b.name).readOnlyHint !== false)
    .map((b) => b.name);
  assert.deepEqual(lying, [], `these write-gated tools claim to be read-only: ${lying.join(", ")}`);
});

test("PLANT: every mutating tool declares destructiveHint true", () => {
  const mutating = toolBlocks().filter((b) => matches(b.body, WRITE_GATE) && matches(b.body, DESTRUCTIVE));
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
