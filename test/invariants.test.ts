import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles, toolBlocks, type ToolBlock } from "./source-files.ts";
import { TOOL_GRANTS, requiredGrant } from "../src/scope.ts";

// The two write-path invariants, guarded.
//
// capsid/conventions.md and this repo's CLAUDE.md both state them as rules:
//   1. Every overwrite and delete snapshots the prior row into document_versions
//      and appends to audit_log. "Do not add a write path that skips this."
//   2. Every mutating tool is gated on the write grant, so an `ro:` key cannot
//      reach it.
//
// Until 2026-08-13 both were enforced by nothing but review, and the failure is silent in
// both directions: a write path with no snapshot works perfectly until someone needs the
// snapshot, and a missing operator gate is invisible because the tool it exposes does its
// job.
//
// This file is the source-guard half (invariant 2, plus a structural check that
// invariant 1's statements exist per tool). The behavioural half is
// test/write-invariants.test.ts, which drives the real handlers against a fake D1
// and asserts the statements are actually issued.
//
// IT SCANS EVERY FILE UNDER src/, not just server.ts (quality audit 1.1). These
// are properties of a TOOL, and server.ts is only where the tools happen to live
// today. A tool registered from a new module was invisible here and the suite
// reported green over a surface it had never read. Widening it is also what lets
// server.ts be split later without blinding the guard.

const MUTATING_SQL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
// THE GATE MOVED, AND THERE IS STILL EXACTLY ONE PER WRITE TOOL.
//
// It used to be the line `if (!mayWrite) return fail(DENIED)`, spelled once inside
// each write handler. It is now src/scope.ts, reached two ways, and a write tool has
// to be covered by one of them:
//
//   - THE REGISTRAR, for a tool that writes whatever action it is called with. Its
//     requirement is `write` in TOOL_GRANTS and the wrapper checks it before the
//     handler runs, so the handler carries no gate of its own and cannot forget one.
//   - AN INLINE ctx.scope call asking for the write grant, for the two tools whose
//     requirement depends on their action (`jobs` has a read action, `lint` has
//     gather). The registrar cannot decide those, so they check at the point where
//     the action is known.
//
// Asserting coverage rather than a spelling is what makes this stronger than what it
// replaces: the old scan could only see a gate in a handler that contained its own
// SQL, so every tool whose writes happen a module away (the queue, the improve loop,
// every repo write) had to be trusted or named by hand.
const SCOPE_GATE = /ctx\.scope\(\{[^}]*grant: "write"/;

const BLOCKS: ToolBlock[] = toolBlocks();

test("the block scan found the whole tool surface", () => {
  // Vacuity guard. If this parse broke, every assertion below would pass over an
  // empty list and the file would be worthless while looking green.
  assert.ok(BLOCKS.length >= 20, `expected the full tool surface, parsed ${BLOCKS.length} blocks`);
  for (const name of ["write", "delete", "move", "lint", "restore", "read", "search"]) {
    assert.ok(BLOCKS.some((b) => b.name === name), `did not parse a block for the ${name} tool`);
  }
  // And the walk itself reached the whole directory. sourceFiles() throws below
  // its own floor; this is the second half, asserting the scan is not reading one
  // file that happens to contain everything today.
  assert.ok(sourceFiles().length >= 10, "the src/ walk collapsed to a handful of files");
});

test("every tool whose handler contains mutating SQL is gated on the write grant", () => {
  const ungated = BLOCKS.filter(
    (b) => MUTATING_SQL.test(b.body) && requiredGrant(b.name) !== "write" && !SCOPE_GATE.test(b.body)
  ).map((b) => `${b.name} (src/${b.file})`);
  assert.deepEqual(
    ungated,
    [],
    `these tools issue INSERT/UPDATE/DELETE and are neither write-gated at the registrar (TOOL_GRANTS) nor carrying their own ctx.scope grant check, so a read-only caller can reach them: ${ungated.join(", ")}`
  );
});

test("EVERY registered tool has a stated requirement, in both directions", () => {
  // The registrar reads TOOL_GRANTS to decide what a call needs. A tool missing from
  // it falls back to `write`, which is the safe direction and is still a drift: the
  // table would be describing a surface it no longer covers. An entry with no tool is
  // the other direction, and means a tool was renamed or removed and its requirement
  // was left behind.
  const registered = BLOCKS.map((b) => b.name).sort();
  assert.deepEqual(Object.keys(TOOL_GRANTS).sort(), registered);
});

test("a tool marked read does not mutate, which is the claim it would be dangerous to get wrong", () => {
  // The direction that matters. A write tool wrongly marked `read` is admitted for a
  // read-only caller by the registrar and then writes.
  const lying = BLOCKS.filter((b) => requiredGrant(b.name) === "read" && MUTATING_SQL.test(b.body)).map((b) => b.name);
  assert.deepEqual(lying, [], `these tools are marked read in TOOL_GRANTS and contain mutating SQL: ${lying.join(", ")}`);
  // Vacuity: the classification is not simply empty of read tools.
  const reads = BLOCKS.filter((b) => requiredGrant(b.name) === "read").length;
  assert.ok(reads >= 8, `only ${reads} tools classify as read; the derivation is broken`);
});

test("the two action-scoped tools really do carry their own check", () => {
  // They are the only tools the registrar cannot decide for, so they are the only
  // ones where forgetting the call leaves a hole. Named, because there being exactly
  // two of them is the property: a third would mean the registrar is losing ground.
  const actionScoped = Object.entries(TOOL_GRANTS)
    .filter(([, requirement]) => requirement === "action")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(actionScoped, ["jobs", "lint"]);
  for (const name of actionScoped) {
    const block = BLOCKS.find((b) => b.name === name);
    assert.ok(block, `no block parsed for ${name}`);
    assert.match(block.body, SCOPE_GATE, `${name} is action-scoped and carries no ctx.scope write check`);
  }
});

test("the gate check is not vacuous: several tools are found to be mutating", () => {
  // If a refactor moved every statement into a helper, the test above would pass
  // by matching nothing. This asserts it is still looking at real mutations.
  const mutating = BLOCKS.filter((b) => MUTATING_SQL.test(b.body)).map((b) => b.name);
  assert.ok(mutating.length >= 6, `only ${mutating.length} tool handlers contain mutating SQL: ${mutating.join(", ")}`);
  for (const name of ["write", "delete", "move", "restore"]) {
    assert.ok(mutating.includes(name), `${name} no longer contains mutating SQL; has it moved to a helper?`);
  }
});

test("the one mutating helper outside a tool handler carries the gate itself", () => {
  // guardedWrite writes the audit row for the repo tools, so their own blocks
  // contain no SQL and the scan above cannot see them. The gate has to be here.
  // Located by search rather than by filename, so moving it to another module
  // keeps the guard rather than silently losing it.
  const owner = sourceFiles().find((f) => f.text.includes("const guardedWrite"));
  assert.ok(owner, "could not locate guardedWrite anywhere under src/");
  const helper = owner.text.slice(owner.text.indexOf("const guardedWrite"), owner.text.indexOf("const REPO_ARG"));
  assert.ok(helper.length > 200, `could not bound guardedWrite in src/${owner.name}`);
  assert.ok(MUTATING_SQL.test(helper), "guardedWrite no longer writes the audit row");
  assert.match(
    helper,
    SCOPE_GATE,
    "guardedWrite lost its scope check: every repo write tool is now unchecked for the grant and for the flags a repo mutation needs"
  );
  assert.match(
    helper,
    /repoWriteFlags\(/,
    "guardedWrite no longer computes the flags a repo mutation needs, so can_merge, can_direct_write, can_dispatch, can_write_workflows, can_touch_protected and money_paths are checked nowhere"
  );
});
