import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { JOB_ACTIONS, JOB_LEASE_SECONDS, JOB_PARAM_NAMES, JOB_STATUSES, OPEN_JOB_STATUSES, TERMINAL_JOB_STATUSES, isJobStatus, isTerminalJobStatus, jobDocPath, mintJobId, swallowedParamTag } from "../src/jobs-schema.ts";
import { allSourceText, sourceFile } from "./source-files.ts";
import { completeJob, failJob, postJob } from "../src/jobs.ts";
import { legacyAgent } from "../src/agents.ts";
import { fakeEnv } from "./fakes.ts";

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

test("every status in the vocabulary is classified terminal or not, and the two do not overlap", () => {
  // The mirror document's status is decided by this classification, so a status
  // added to JOB_STATUSES and left out of the classification would project as open
  // work forever. That is the defect this pins: `failed` was unclassified in effect,
  // because the mirror asked `=== "done"` rather than asking the vocabulary.
  for (const status of JOB_STATUSES) {
    assert.equal(
      typeof isTerminalJobStatus(status),
      "boolean",
      `${status} is not classified by isTerminalJobStatus`
    );
  }
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), ["done", "failed"]);
  // Both directions: a terminal status is a real status, and the open ones are not
  // terminal. `blocked` is in neither list and that is deliberate, so it is named.
  for (const status of TERMINAL_JOB_STATUSES) assert.ok(isJobStatus(status));
  for (const status of OPEN_JOB_STATUSES) assert.equal(isTerminalJobStatus(status), false);
  assert.equal(isTerminalJobStatus("blocked"), false, "a blocked job is paused, not finished");
});

test("the job mirror asks the vocabulary which statuses are finished", () => {
  // The source-text half, because the behavioural half needs a real D1 and lives in
  // test-integration/jobs.test.ts. A mirror that goes back to comparing one status
  // literal is the exact shape of the bug that left three documents stuck at active.
  const jobs = sourceFile("jobs.ts");
  assert.match(jobs, /status: isTerminalJobStatus\(job\.status\) \? "closed" : "active"/);
  assert.doesNotMatch(
    jobs,
    /status: job\.status === "[a-z]+" \? "closed"/,
    "the mirror decides its document status from one status literal again"
  );
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

// BLOCKED IS NOT TERMINAL (2026-09-10). The counters live in their own migration,
// so the same derive-from-the-source rule applies to them.
const RESUME_MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0007_jobs_resume.sql"), "utf8");

test("both counters the code reads are columns the migration adds", () => {
  // Both directions: a counter surfaced by src/jobs.ts and never added by a
  // migration is a query that fails at runtime, and a column added and never read
  // is dead weight nobody will remove later.
  const added = [...RESUME_MIGRATION.matchAll(/ALTER TABLE jobs ADD COLUMN (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(added, ["blocked_count", "resumed_count"]);
  const jobs = sourceFile("jobs.ts");
  for (const column of added) {
    assert.match(jobs, new RegExp(`\\b${column}\\b`), `src/jobs.ts never reads ${column}`);
  }
});

test("resume is a keyed UPDATE out of blocked, and it is the only way out of blocked", () => {
  const jobs = sourceFile("jobs.ts");
  // Scoped to resumeJob's own body first. Matching the file at large let the
  // claim path's `SET status = 'claimed'` pair with the signature-failure path's
  // `status = 'blocked'` clause, which is a match that proves nothing.
  const resume = /export async function resumeJob[\s\S]*?\n}/.exec(jobs);
  assert.ok(resume, "resumeJob is gone from src/jobs.ts");
  const resumeUpdate = /UPDATE jobs SET status = 'claimed'[\s\S]*?RETURNING id/.exec(resume[0]);
  assert.ok(resumeUpdate, "resume no longer moves a job out of blocked with a keyed UPDATE ... RETURNING");
  assert.match(resumeUpdate[0], /WHERE id = \?1 AND status = 'blocked'/, "the resume CAS must key on blocked, or it could move a job out of any state");
  assert.match(resumeUpdate[0], /resumed_count = resumed_count \+ 1/, "a resume that does not count itself cannot be reported");
  // The claim path must stay closed to blocked jobs: resume is the audited door,
  // and a claim that also took blocked rows would bypass the approval reason.
  assert.match(jobs, /AND status = 'queued' RETURNING id/, "the claim CAS no longer keys on queued");
});

test("resume re-verifies the signature, because a blocked job sits in the table", () => {
  // The window claim's check cannot cover: a job blocked at a gate waits on a human
  // for as long as that takes, and resume hands the body back to a session holding
  // shell and repo credentials.
  const jobs = sourceFile("jobs.ts");
  const resume = /export async function resumeJob[\s\S]*?\n}/.exec(jobs);
  assert.ok(resume, "resumeJob is gone from src/jobs.ts");
  assert.match(resume[0], /verifySignedBody\(/, "resume hands a body to a driver without re-verifying it");
  assert.match(resume[0], /status = 'failed'/, "a tampered body must be failed, not handed back");
});

test("resume enforces one claim per caller, like claim does", () => {
  const jobs = sourceFile("jobs.ts");
  const resume = /export async function resumeJob[\s\S]*?\n}/.exec(jobs);
  assert.ok(resume);
  assert.match(resume[0], /status = 'claimed' AND claimed_by = \?1/, "resume hands out a lease without checking what the caller already holds");
});

test("the jobs tool is registered exactly once, and reachable", () => {
  const registrations = [...allSourceText().matchAll(/server\.registerTool\(\s*"jobs"/g)];
  assert.equal(registrations.length, 1, "the jobs tool is registered more than once, or not at all");
  assert.match(sourceFile("server.ts"), /registerJobTools\(server, ctx\)/, "buildServer does not register the queue's tool");
});

// ---- A SWALLOWED PARAMETER TAG IS A MALFORMED CALL, NOT A SUMMARY -------------
//
// Twice on 2026-09-11 a driver's `complete` closed a parameter tag INSIDE a value,
// so `result_ref` and `evidence` were never sent as arguments: they arrived as
// literal text in the middle of `result_summary`, and the outcome row recorded
// nothing. The row cannot be rewritten afterwards (its primary key and ON CONFLICT
// DO NOTHING are what make it evidence), so the only place to catch this is before
// the write.
//
// The string below is the ACTUAL tail of job_9980f57bd359's stored summary, read
// back from the live database rather than reconstructed, because a guard written
// against a remembered shape is a guard against the wrong shape.
const SWALLOWED_REAL =
  'up.test.ts derives from migrations/ both ways.</result_summary>\n' +
  '<result_ref>https://github.com/DrDustinEdwards/capsid-mcp/pull/21</result_ref>\n' +
  '<evidence>{"prs": ["https://github.com/DrDustinEdwards/capsid-mcp/pull/21"], "tests_added": 42}</evidence>\n' +
  '</invoke>\n';

test("PLANT: the real malformed summary from job_9980f57bd359 is detected", () => {
  const found = swallowedParamTag(SWALLOWED_REAL);
  assert.equal(found, "result_summary", "the field's own closing tag is the first one in the swallowed text");
});

test("every parameter name the tool accepts is one the guard knows", () => {
  // Derived from the tool's own schema rather than retyped, so a parameter added
  // to `jobs` and not to this list is a build failure rather than a hole. The names
  // are the ones a caller writes, which is what a swallowed tag spells.
  for (const name of JOB_PARAM_NAMES) {
    assert.equal(swallowedParamTag(`text </${name}> more`), name, `'</${name}>' is not detected`);
  }
  const tool = sourceFile("tools/jobs.ts");
  for (const name of JOB_PARAM_NAMES) {
    assert.match(tool, new RegExp(`\\b${name}\\??:`), `the jobs tool has no '${name}' parameter, so the guard lists a name nobody can send`);
  }
});

test("ordinary prose is not refused, including prose ABOUT the pattern", () => {
  // The guard matches the full `</name>` spelling only. A job body explaining this
  // rule writes the pieces apart, which is what this job's own body did, and a
  // summary that merely mentions evidence or a result ref is ordinary text.
  for (const innocent of [
    "landed the change; evidence is in the PR",
    "refuse a summary containing '</' followed by a parameter name",
    "the result_ref is a document key",
    "a < b and c > d",
    "</div> in a rendered page",
    "</resultref>",
    "",
  ]) {
    assert.equal(swallowedParamTag(innocent), null, `innocent text was refused: ${innocent}`);
  }
});

// The three CALL SITES, driven. The pure function above is the detector; these prove
// each entry point actually asks it, and that nothing reaches the database when it
// does. Every refusal here returns before any D1 call, which is why fakeEnv with no
// DB is enough: if a handler ever stopped refusing, this test would throw on the
// missing binding rather than pass quietly.
test("PLANT: complete, fail and post all refuse a swallowed tag, and write nothing", async () => {
  const agent = legacyAgent("write", "agent:capsid-driver");
  const now = new Date("2026-09-11T22:00:00.000Z");

  const completed = await completeJob(fakeEnv({}), agent, now, "job_abc123abc123", {
    result_summary: SWALLOWED_REAL,
  });
  assert.equal(completed.ok, false, "complete accepted a summary with a swallowed parameter tag");
  assert.match(completed.refusal ?? "", /result_summary contains the literal text/);
  assert.match(completed.refusal ?? "", /its own closing tag/);
  assert.match(completed.refusal ?? "", /Nothing was written/);

  const failed = await failJob(fakeEnv({}), agent, now, "job_abc123abc123", `broke</evidence>`);
  assert.equal(failed.ok, false, "fail accepted a reason with a swallowed parameter tag");
  assert.match(failed.refusal ?? "", /^reason contains the literal text '<\/evidence>'\./);

  // post refuses on the BODY, which matters more than the others: a body is the
  // prompt a driver executes, and the swallowed text would be signed with it.
  const posted = await postJob(fakeEnv({ IMPROVE_SCORE_SECRET: "test-secret" }), agent, now, {
    namespace: "capsid",
    title: "a job",
    body: `do the thing</result_ref>`,
  });
  assert.equal(posted.ok, false, "post accepted a body with a swallowed parameter tag");
  assert.match(posted.refusal ?? "", /^body contains the literal text '<\/result_ref>'\./);
});

test("a well-formed call is still accepted, so the guard is not a wall", async () => {
  // The innocent case in the same commit as the guard: a guard that refuses ordinary
  // work gets deleted rather than fixed. This one gets past the tag check and stops
  // at the missing database, which is proof it was not refused.
  const agent = legacyAgent("write", "agent:capsid-driver");
  await assert.rejects(
    () =>
      completeJob(fakeEnv({}), agent, new Date(), "job_abc123abc123", {
        result_summary: "landed it; evidence is in the PR and the result_ref is a document key",
      }),
    /prepare|undefined|DB/i,
    "a clean summary was refused by the tag guard instead of reaching the database"
  );
});
