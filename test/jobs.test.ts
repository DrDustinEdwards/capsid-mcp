import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JOB_ACTIONS, JOB_LEASE_SECONDS, JOB_STATUSES, OPEN_JOB_STATUSES, isJobStatus, jobDocPath, mintJobId } from "../src/jobs-schema.ts";
import { allSourceText, sourceFile } from "./source-files.ts";

// THE WORK QUEUE'S VOCABULARY, DERIVED FROM THE MIGRATION.
//
// The behavioural half is test-integration/jobs.test.ts, which drives the real
// lifecycle against a real D1: the partial unique index, the claim CAS and the
// lease sweep are all properties of SQLite, and a fake would agree with whatever it
// was asked. This half is the part node can read that workerd cannot: the migration
// FILE, so the statuses the code believes in and the statuses the index enforces
// cannot drift apart.

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0006_jobs.sql"), "utf8");

test("the partial index and OPEN_JOB_STATUSES name the same two statuses", () => {
  // The index is what refuses a duplicate open job; OPEN_JOB_STATUSES is what the
  // code believes it says. Both directions, so adding a status to one and not the
  // other is a build failure rather than a duplicate nobody expected.
  const clause = /WHERE status IN \(([^)]*)\)/.exec(MIGRATION);
  assert.ok(clause, "the partial unique index is gone from migrations/0006_jobs.sql");
  const inIndex = clause[1]
    .split(",")
    .map((s) => s.trim().replace(/'/g, ""))
    .sort();
  assert.deepEqual(inIndex, [...OPEN_JOB_STATUSES].sort());
});

test("every status the code knows is a status the migration's comment declares", () => {
  // The column is a bare TEXT with no CHECK, so the migration's own comment is the
  // schema's statement of the vocabulary. Asserting against it keeps that comment
  // honest rather than decorative.
  const declared = /-- (queued \| claimed \| done \| failed \| blocked)\./.exec(MIGRATION);
  assert.ok(declared, "migrations/0006_jobs.sql no longer declares the status vocabulary");
  assert.deepEqual(declared[1].split(" | ").sort(), [...JOB_STATUSES].sort());
});

test("isJobStatus refuses anything that is not one of them", () => {
  for (const status of JOB_STATUSES) assert.ok(isJobStatus(status));
  for (const bad of ["", "QUEUED", "running", "constructor", "toString", null, 3]) {
    assert.equal(isJobStatus(bad), false, `${String(bad)} is not a job status`);
  }
});

test("a job id is minted, not sequential", () => {
  // A sequential id invites addressing a job by arithmetic, and these are quoted in
  // chat. Two mints differ, and both are the declared shape.
  const a = mintJobId();
  const b = mintJobId();
  assert.match(a, /^job_[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.equal(jobDocPath(a), `jobs/${a}.md`);
});

test("the lease is the four hours the table's comment claims", () => {
  assert.equal(JOB_LEASE_SECONDS, 4 * 60 * 60);
  assert.match(MIGRATION, /lease_expires four hours out/);
});

test("every action the schema advertises is one the tool handles", () => {
  // The enum in the tool schema is what a client can call; JOB_ACTIONS is what the
  // description and the driver are written against. Derived from the source so an
  // action added to one and not the other fails here.
  const tool = sourceFile("tools/jobs.ts");
  for (const action of JOB_ACTIONS) {
    assert.match(tool, new RegExp(`case "${action}"|action === "${action}"`), `the jobs tool has no branch for '${action}'`);
  }
});

test("every queue transition is a keyed UPDATE with RETURNING, never meta.changes", () => {
  // The rule the improve state machine already runs on, applied to the queue. A
  // transition that read meta.changes would be counting the FTS5 triggers on the
  // document write that rides in the same batch.
  const jobs = sourceFile("jobs.ts");
  const updates = [...jobs.matchAll(/UPDATE jobs SET[\s\S]*?(?=`)/g)].map((m) => m[0]);
  assert.ok(updates.length >= 3, `found ${updates.length} UPDATE statements in src/jobs.ts; the scan is broken`);
  for (const update of updates) {
    assert.match(update, /\bWHERE\b/, "an unkeyed UPDATE would move every job in the table");
    assert.match(update, /RETURNING/, "a transition without RETURNING cannot tell a win from a lost race");
  }
  // Comment lines stripped first. The file's own header says "never meta.changes",
  // and a guard a comment can trip is one that gets deleted rather than fixed.
  const code = jobs
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /meta\.changes/, "src/jobs.ts reads meta.changes, which the FTS5 triggers inflate");
});

test("the queue's writes go through the shared document statements, not a second write path", () => {
  // Hard rule 5: no write path skips document_versions and audit_log. The mirror
  // uses improveDocStatements, which carries both in the same batch, rather than
  // spelling its own upsert.
  const jobs = sourceFile("jobs.ts");
  assert.match(jobs, /improveDocStatements\(/, "the job mirror no longer uses the shared document statements");
  assert.doesNotMatch(jobs, /INSERT INTO documents/, "src/jobs.ts spells its own document upsert");
  assert.doesNotMatch(jobs, /INSERT INTO document_versions/, "src/jobs.ts spells its own snapshot");
});

test("the jobs tool is registered exactly once, and reachable", () => {
  const registrations = [...allSourceText().matchAll(/server\.registerTool\(\s*"jobs"/g)];
  assert.equal(registrations.length, 1, "the jobs tool is registered more than once, or not at all");
  assert.match(sourceFile("server.ts"), /registerJobTools\(server, ctx\)/, "buildServer does not register the queue's tool");
});
