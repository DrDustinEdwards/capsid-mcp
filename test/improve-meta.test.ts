import assert from "node:assert/strict";
import { test } from "node:test";
import { assertProposalTarget, META_PROTECTED_PATHS, metaIsDue } from "../src/improve-meta.ts";
import { META_INTERVAL_MS, PROPOSAL_PREFIX, RUN_PROMPT_PATH, SCORES_PATH, proposalPath } from "../src/improve-schema.ts";
import { fakeKv } from "./fakes.ts";
import { sourceFile } from "./source-files.ts";

// THE META-LOOP'S BOUNDARY.
//
// A system that can edit its own objective has no objective. The meta-loop
// proposes an edit to the run prompt and a human applies it; the distinction
// between proposing and applying is the entire safety property, and
// assertProposalTarget is where it lives.

test("THE META-LOOP CANNOT WRITE THE RUN PROMPT", () => {
  // The document it exists to comment on is the one it may not touch.
  const refusal = assertProposalTarget({ namespace: "capsid", path: RUN_PROMPT_PATH });
  assert.ok(refusal, "the meta-loop was allowed to write the run prompt");
  assert.match(refusal, /one of the documents the loop is measured against/);
  assert.match(refusal, /It may only propose/);
});

test("THE META-LOOP CANNOT WRITE A SCORES DOCUMENT", () => {
  const refusal = assertProposalTarget({ namespace: "capsid", path: SCORES_PATH });
  assert.ok(refusal, "the meta-loop was allowed to write a scores document");
  assert.match(refusal, /measured against/);
});

test("the protected list names both documents, and neither is empty", () => {
  assert.deepEqual([...META_PROTECTED_PATHS].sort(), [RUN_PROMPT_PATH, SCORES_PATH].sort());
  for (const path of META_PROTECTED_PATHS) assert.ok(path.length > 0);
});

test("it cannot write to another namespace", () => {
  for (const namespace of ["foxing", "germomics", "dustinedwards", "foxhound", "capsid-evil"]) {
    const refusal = assertProposalTarget({ namespace, path: proposalPath("run-prompt", "2026-09-04") });
    assert.ok(refusal, `the meta-loop was allowed to write to ${namespace}`);
    assert.match(refusal, /may only write to the capsid namespace/);
  }
});

test("it cannot write outside the proposals prefix", () => {
  for (const path of ["core.md", "decisions.md", "improve/README.md", "improve/skills/x.md", "improve/archive/r/a.md"]) {
    const refusal = assertProposalTarget({ namespace: "capsid", path });
    assert.ok(refusal, `the meta-loop was allowed to write capsid/${path}`);
    assert.match(refusal, /may only write under improve\/proposals\//);
  }
});

test("it cannot climb out of its prefix with ..", () => {
  // This module does not go through docPath's grammar, so it checks traversal
  // itself. Without this, `improve/proposals/../../core.md` starts with the
  // prefix and passes.
  const refusal = assertProposalTarget({ namespace: "capsid", path: `${PROPOSAL_PREFIX}../../core.md` });
  assert.ok(refusal, "a traversal path was accepted");
  assert.match(refusal, /may not write a path containing '\.\.'/);
});

test("a real proposal path IS allowed, so the gate is not a blanket refusal", () => {
  assert.equal(assertProposalTarget({ namespace: "capsid", path: proposalPath("run-prompt", "2026-09-04") }), null);
  assert.equal(assertProposalTarget({ namespace: "capsid", path: `${PROPOSAL_PREFIX}anything.md` }), null);
});

test("EVERY WRITE IN THE MODULE PASSES THROUGH THE GATE", () => {
  // A source guard, because the behavioural half cannot prove a path that does not
  // exist yet. If a second write is ever added here without a check in front of
  // it, this fails.
  const meta = sourceFile("improve-meta.ts");
  const writes = meta.split("improveDocStatements(").length - 1;
  const checks = meta.split("assertProposalTarget(").length - 1;
  assert.ok(writes >= 1, "the meta-loop no longer writes anything; this guard is now vacuous");
  // One definition plus one call site per write.
  assert.ok(
    checks >= writes + 1,
    `the meta-loop makes ${writes} document write(s) and calls assertProposalTarget ${checks - 1} time(s); every write needs one in front of it`
  );
  // And the status it writes with says the proposal is not in force.
  assert.match(meta, /status: "draft"/);
  assert.match(meta, /\*\*NOT APPLIED\.\*\*/);
});

test("the module does not import anything that could apply a proposal", () => {
  // It reads the run prompt to reason about it and writes only under the
  // proposals prefix. A path mutation, a delete, or a repo write here would be a
  // way around the gate rather than through it.
  const meta = sourceFile("improve-meta.ts");
  for (const forbidden of ["pathMutation", "writeRepoFile", "deleteRepoFile", "DELETE FROM"]) {
    assert.equal(meta.includes(forbidden), false, `src/improve-meta.ts reaches for ${forbidden}`);
  }
});

// ---- the weekly cadence -----------------------------------------------------

const NOW = new Date("2026-09-04T12:00:00Z");

test("an unset marker means due", async () => {
  const { kv } = fakeKv();
  assert.equal(await metaIsDue(kv, NOW), true);
});

test("a marker inside the window means not due", async () => {
  const { kv } = fakeKv({ seed: { "improve:meta:last": new Date(NOW.getTime() - 86_400_000).toISOString() } });
  assert.equal(await metaIsDue(kv, NOW), false);
});

test("a marker older than the interval means due", async () => {
  const { kv } = fakeKv({ seed: { "improve:meta:last": new Date(NOW.getTime() - META_INTERVAL_MS - 1000).toISOString() } });
  assert.equal(await metaIsDue(kv, NOW), true);
});

test("an unparseable or unreadable marker means DUE, not blocked", async () => {
  // The failure mode of running twice is a duplicate proposal nobody has to act
  // on. The failure mode of never running is a run prompt that never improves.
  const garbage = fakeKv({ seed: { "improve:meta:last": "some time last week" } });
  assert.equal(await metaIsDue(garbage.kv, NOW), true);
  const broken = fakeKv({ failGet: true });
  assert.equal(await metaIsDue(broken.kv, NOW), true);
});
