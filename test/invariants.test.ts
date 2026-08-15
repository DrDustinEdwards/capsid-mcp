import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFiles } from "./source-files.ts";

// The two write-path invariants, guarded.
//
// capsid/conventions.md and this repo's CLAUDE.md both state them as rules:
//   1. Every overwrite and delete snapshots the prior row into document_versions
//      and appends to audit_log. "Do not add a write path that skips this."
//   2. Every mutating tool is gated on the write grant, so an `ro:` key cannot
//      reach it.
//
// Until 2026-08-13 both were enforced by nothing but review. They are exactly the
// kind of rule that survives every session until the session that adds a fifth
// mutating tool in a hurry, and the failure is silent in both directions: a write
// path with no snapshot works perfectly until someone needs the snapshot, and a
// missing operator gate is invisible because the tool it exposes does its job.
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
// server.ts be split later without blinding the guard, which is the whole point
// of this batch.

const MUTATING_SQL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
const OPERATOR_GATE = "if (!operator)";

interface Block {
  tool: string;
  text: string;
  file: string;
}

// Each registerTool call, from its name to the start of the next registration.
// Crude on purpose: a parser would be more precise and would also be a second
// implementation of TypeScript in a test file.
//
// Scanned per FILE rather than over a concatenation of all of src/, so a block
// cannot run past the end of its own module and swallow the next file's text, and
// so a failure names the file the offending tool lives in.
function toolBlocks(): Block[] {
  const marker = "server.registerTool(";
  const blocks: Block[] = [];
  for (const { name, text } of sourceFiles()) {
    const starts: number[] = [];
    for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + 1)) starts.push(i);
    if (starts.length === 0) continue;
    const resourceStart = text.indexOf("server.registerResource(");
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      // The block ends at the next registration, or at the resource registration
      // if that comes first, or at the end of the file.
      const bounds = [
        i + 1 < starts.length ? starts[i + 1] : text.length,
        resourceStart > start ? resourceStart : text.length,
      ];
      const body = text.slice(start, Math.min(...bounds));
      blocks.push({
        file: name,
        text: body,
        tool: body.match(/registerTool\(\s*\n?\s*"([^"]+)"/)?.[1] ?? `${name}#${i}`,
      });
    }
  }
  return blocks;
}

const BLOCKS = toolBlocks();

test("the block scan found the whole tool surface", () => {
  // Vacuity guard. If this parse broke, every assertion below would pass over an
  // empty list and the file would be worthless while looking green.
  assert.ok(BLOCKS.length >= 20, `expected the full tool surface, parsed ${BLOCKS.length} blocks`);
  for (const name of ["write", "delete", "move", "lint", "restore", "read", "search"]) {
    assert.ok(BLOCKS.some((b) => b.tool === name), `did not parse a block for the ${name} tool`);
  }
  // And the walk itself reached the whole directory. sourceFiles() throws below
  // its own floor; this is the second half, asserting the scan is not reading one
  // file that happens to contain everything today.
  assert.ok(sourceFiles().length >= 10, "the src/ walk collapsed to a handful of files");
});

test("every tool whose handler contains mutating SQL is gated on the write grant", () => {
  const ungated = BLOCKS.filter((b) => MUTATING_SQL.test(b.text) && !b.text.includes(OPERATOR_GATE)).map(
    (b) => `${b.tool} (src/${b.file})`
  );
  assert.deepEqual(
    ungated,
    [],
    `these tools issue INSERT/UPDATE/DELETE with no "${OPERATOR_GATE}" gate, so a read-only ro: key can reach them: ${ungated.join(", ")}`
  );
});

test("the gate check is not vacuous: several tools are found to be mutating", () => {
  // If a refactor moved every statement into a helper, the test above would pass
  // by matching nothing. This asserts it is still looking at real mutations.
  const mutating = BLOCKS.filter((b) => MUTATING_SQL.test(b.text)).map((b) => b.tool);
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
  assert.ok(helper.includes(OPERATOR_GATE), "guardedWrite lost its operator gate: every repo write tool is now open to ro: keys");
});

test("every tool that overwrites or removes a document snapshots and audits it", () => {
  // Structural, per tool. The behavioural proof is in write-invariants.test.ts;
  // this is the cheap version that names the specific tool that lost a statement.
  for (const tool of ["write", "delete", "restore"]) {
    const block = BLOCKS.find((b) => b.tool === tool)!;
    assert.match(
      block.text,
      /INSERT INTO document_versions/,
      `${tool} no longer snapshots the prior row into document_versions`
    );
    assert.match(block.text, /INSERT INTO audit_log/, `${tool} no longer appends to audit_log`);
  }
  const move = BLOCKS.find((b) => b.tool === "move")!;
  // move renames rather than overwriting, so there is no body to snapshot, but the
  // audit row is what the 2026-08-10 edge repair recovered five repoints from.
  assert.match(move.text, /INSERT INTO audit_log/, "move no longer appends to audit_log");
});
