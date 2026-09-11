import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, completeJob, expireJobLeases, failJob, heartbeatJob, jobsSummary, listJobs, postJob, resumeJob } from "../src/jobs";
import { improveStatus } from "../src/improve-run";
import { legacyAgent } from "../src/agents";
import { JOB_LEASE_SECONDS, jobDocPath } from "../src/jobs-schema";
import { splitSignedTask, verifyTaskDoc } from "../src/improve-task";

// THE WORK QUEUE, AGAINST A REAL D1.
//
// This suite lives in the integration layer rather than beside the unit tests, and
// that is the whole point of it: every property under test is a property of the
// DATABASE, not of a handler.
//
//   - the partial unique index over (namespace, title) is what refuses a duplicate
//     post, and only SQLite enforces it;
//   - the claim is `UPDATE ... WHERE status = 'queued' RETURNING id`, so "exactly
//     one of two callers wins" is a statement about SQLite's transaction, not about
//     the code around it;
//   - the lease sweep is a keyed UPDATE with RETURNING over a real datetime
//     comparison.
//
// A fake that answered these by SQL shape would agree with whatever it was asked,
// which is the failure mode test/fakes.ts's own header records.

const SECRET = "test-root-secret";
const SEAT = "github:DrDustinEdwards";
const DRIVER_ACTOR = "opkey:aaaabbbbcccc";
const OTHER_ACTOR = "opkey:ddddeeeeffff";
// A claim is authorized against a CALLER now, not an actor string (migrations/0008).
// These two are the legacy operator identity, which is what every existing claim in
// the portfolio still presents and what these tests are about: the lease, the CAS and
// the unique index are properties of SQLite and do not change with the caller.
const DRIVER = legacyAgent("write", DRIVER_ACTOR);
const OTHER = legacyAgent("write", OTHER_ACTOR);

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-10T12:00:00.000Z");

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function auditActions(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT action FROM audit_log WHERE params LIKE ?1 ORDER BY id ASC"
  )
    .bind(`%${id}%`)
    .all<{ action: string }>();
  return (results ?? []).map((r) => r.action);
}

async function post(over: Partial<{ namespace: string; title: string; body: string; priority: number; gate_required: boolean }> = {}) {
  return postJob(jobsEnv(), legacyAgent("write", SEAT), NOW, {
    namespace: "capsid",
    title: "a job",
    body: "do the thing",
    ...over,
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
});

describe("the lifecycle", () => {
  it("post, claim, complete, and the row carries what each step recorded", async () => {
    const posted = await post({ title: "post claim complete" });
    expect(posted.ok, posted.refusal).toBe(true);
    const id = posted.job!.id;
    expect(id).toMatch(/^job_[0-9a-f]{12}$/);
    expect(posted.job!.status).toBe("queued");
    expect(posted.job!.posted_by).toBe(SEAT);

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(claimed.ok, claimed.refusal).toBe(true);
    expect(claimed.job!.id).toBe(id);
    expect(claimed.job!.claimed_by).toBe(DRIVER_ACTOR);
    // The lease is four hours out, from the clock the caller passed rather than the
    // runner's, so this is an assertion about the value and not about timing.
    expect(claimed.job!.lease_expires).toBe(new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000).toISOString());

    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, {
      result_summary: "did the thing",
      result_ref: "capsid/notes.md",
    });
    expect(done.ok, done.refusal).toBe(true);
    const stored = await row(id);
    expect(stored?.status).toBe("done");
    expect(stored?.result_summary).toBe("did the thing");
    expect(stored?.result_ref).toBe("capsid/notes.md");
    // The lease is given back, so a done job holds nothing.
    expect(stored?.lease_expires).toBeNull();
  });

  it("every action writes an audit row naming the caller", async () => {
    const posted = await post({ title: "audited" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await heartbeatJob(jobsEnv(), DRIVER, NOW, id);
    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "s" });

    // Both the queue's own audit row and the mirrored document's write land, which
    // is what makes hard rule 5 hold for a job document as for any other.
    const actions = await auditActions(id);
    expect(actions).toContain("job-posted");
    expect(actions).toContain("job-claimed");
    expect(actions).toContain("job-heartbeat");
    expect(actions).toContain("job-complete");

    const actors = await env.DB.prepare("SELECT DISTINCT actor FROM audit_log WHERE params LIKE ?1")
      .bind(`%${id}%`)
      .all<{ actor: string }>();
    expect(new Set((actors.results ?? []).map((r) => r.actor))).toEqual(new Set([SEAT, DRIVER_ACTOR]));
  });
});

describe("the refusals", () => {
  it("a second open job with the same title is refused by the partial index", async () => {
    const first = await post({ title: "only once" });
    expect(first.ok).toBe(true);
    const second = await post({ title: "only once" });
    expect(second.ok).toBe(false);
    expect(second.refusal).toMatch(/already has an open job titled 'only once'/);

    // And the index is PARTIAL, so the same title is postable again once the first
    // one is out of queued and claimed. A plain unique index would make a recurring
    // job impossible, which is the thing the partial clause buys.
    await claimJob(jobsEnv(), DRIVER, NOW, { id: first.job!.id });
    await failJob(jobsEnv(), DRIVER, NOW, first.job!.id, "gave up");
    const third = await post({ title: "only once" });
    expect(third.ok, third.refusal).toBe(true);
  });

  it("a caller that already holds a claim cannot take another", async () => {
    const a = await post({ title: "first" });
    const b = await post({ title: "second" });
    expect((await claimJob(jobsEnv(), DRIVER, NOW, { id: a.job!.id })).ok).toBe(true);
    const again = await claimJob(jobsEnv(), DRIVER, NOW, { id: b.job!.id });
    expect(again.ok).toBe(false);
    expect(again.refusal).toMatch(new RegExp(`already holds ${a.job!.id}`));
    // And the second job is untouched, not half-claimed.
    expect((await row(b.job!.id))?.status).toBe("queued");
  });

  it("two drivers racing one job resolve to exactly one winner", async () => {
    const posted = await post({ title: "contested" });
    const id = posted.job!.id;
    const [one, two] = await Promise.all([
      claimJob(jobsEnv(), DRIVER, NOW, { id }),
      claimJob(jobsEnv(), OTHER, NOW, { id }),
    ]);
    const winners = [one, two].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const stored = await row(id);
    expect(stored?.status).toBe("claimed");
    expect(stored?.claimed_by).toBe(winners[0].job!.claimed_by);
  });

  it("a holder is the only caller that can finish the job", async () => {
    const posted = await post({ title: "held" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const stolen = await completeJob(jobsEnv(), OTHER, NOW, id, { result_summary: "not mine" });
    expect(stolen.ok).toBe(false);
    expect(stolen.refusal).toMatch(new RegExp(`held by ${DRIVER_ACTOR}, not by ${OTHER_ACTOR}`));
    expect((await row(id))?.status).toBe("claimed");
  });

  it("complete without a summary and fail without a reason are refused", async () => {
    const posted = await post({ title: "needs words" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect((await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "  " })).refusal).toMatch(/needs a result_summary/);
    expect((await failJob(jobsEnv(), DRIVER, NOW, id, "")).refusal).toMatch(/needs a reason/);
    expect((await row(id))?.status).toBe("claimed");
  });

  it("post refuses when there is no key to sign with", async () => {
    const unconfigured = { ...env, IMPROVE_SCORE_SECRET: undefined } as unknown as Parameters<typeof postJob>[0];
    const result = await postJob(unconfigured, legacyAgent("write", SEAT), NOW, { namespace: "capsid", title: "unsignable", body: "x" });
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatch(/IMPROVE_SCORE_SECRET is unset/);
    // Fail closed: nothing queued.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("the lease", () => {
  it("an expired lease returns the job to queued, and a live one does not", async () => {
    const live = await post({ title: "still working" });
    const dead = await post({ title: "driver died" });
    await claimJob(jobsEnv(), DRIVER, NOW, { id: dead.job!.id });
    await claimJob(jobsEnv(), OTHER, NOW, { id: live.job!.id });

    // One second before the lease is up: nothing moves. This is the innocent case,
    // and a sweep that fires on it would return a job somebody is still doing.
    const justBefore = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 - 1000);
    expect((await expireJobLeases(jobsEnv(), justBefore)).requeued).toEqual([]);
    expect((await row(dead.job!.id))?.status).toBe("claimed");

    // The live one heartbeats and the dead one does not, so an hour later only one
    // of them is expired. This is what the heartbeat is FOR, asserted rather than
    // assumed.
    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    await heartbeatJob(jobsEnv(), OTHER, new Date(NOW.getTime() + 60_000), live.job!.id);
    const swept = await expireJobLeases(jobsEnv(), later);
    expect(swept.requeued).toEqual([dead.job!.id]);

    const returned = await row(dead.job!.id);
    expect(returned?.status).toBe("queued");
    expect(returned?.claimed_by).toBeNull();
    expect(returned?.lease_expires).toBeNull();
    expect((await row(live.job!.id))?.status).toBe("claimed");

    // And it is claimable again, by anyone.
    const reclaimed = await claimJob(jobsEnv(), legacyAgent("write", SEAT.replace("github:", "opkey:")), later, { id: dead.job!.id });
    expect(reclaimed.ok, reclaimed.refusal).toBe(true);
  });

  it("a caller cannot finish a job whose lease the sweep already returned", async () => {
    const posted = await post({ title: "too slow" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const later = new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000 + 1000);
    await expireJobLeases(jobsEnv(), later);
    const late = await completeJob(jobsEnv(), DRIVER, later, id, { result_summary: "finished eventually" });
    expect(late.ok).toBe(false);
    expect(late.refusal).toMatch(/is queued, not claimed/);
    expect(late.refusal).toMatch(/claim it again/);
  });
});

describe("blocked", () => {
  it("block records the exact command, and the job stops there", async () => {
    const posted = await post({ title: "needs a push", gate_required: true });
    const id = posted.job!.id;
    expect(posted.job!.gate_required).toBe(1);
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, {
      reason: "the change is ready but pushing deploys the Worker",
      command: "git push origin feat/thing",
    });
    expect(blocked.ok, blocked.refusal).toBe(true);
    const stored = await row(id);
    expect(stored?.status).toBe("blocked");
    // The command is what the human needs, so it is IN the summary rather than
    // described by it. The console shows this string.
    expect(String(stored?.result_summary)).toContain("git push origin feat/thing");
    expect(String(stored?.result_summary)).toContain("deploys the Worker");
  });
});

// BLOCKED IS A PAUSE, NOT AN ENDING (2026-09-10). Before resume existed, the only
// door into a claim was from queued, so a job stopped at a gate could never carry
// its own outcome: job_1b957927a714 shipped a commit and four pull requests while
// its row still said the push had not happened.
describe("resume", () => {
  async function blockedJob(title: string) {
    const posted = await post({ title, gate_required: true });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs a human", command: "git push origin main" });
    return id;
  }

  it("block, resume, complete: the same job carries its own outcome", async () => {
    const id = await blockedJob("block resume complete");
    expect((await row(id))?.status).toBe("blocked");

    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "seat approved the push");
    expect(resumed.ok, resumed.refusal).toBe(true);
    const held = await row(id);
    expect(held?.status).toBe("claimed");
    expect(held?.claimed_by).toBe(DRIVER_ACTOR);
    // A FRESH LEASE, not the expired one it was blocked with.
    expect(held?.lease_expires).toBe(new Date(NOW.getTime() + JOB_LEASE_SECONDS * 1000).toISOString());
    expect(held?.resumed_count).toBe(1);
    expect(held?.blocked_count).toBe(1);

    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "pushed and verified", result_ref: "abc1234" });
    expect(done.ok, done.refusal).toBe(true);
    const final = await row(id);
    expect(final?.status).toBe("done");
    expect(final?.result_summary).toBe("pushed and verified");
    expect(await auditActions(id)).toEqual(["job-posted", "job-claimed", "job-block", "job-resumed", "job-complete"]);
  });

  it("the approval reason is recorded, not implied", async () => {
    const id = await blockedJob("approval recorded");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "seat approved: ff-merge and push master");
    const { results } = await env.DB.prepare(
      "SELECT params FROM audit_log WHERE action = 'job-resumed' AND params LIKE ?1"
    )
      .bind(`%${id}%`)
      .all<{ params: string }>();
    expect(results?.length).toBe(1);
    expect(String(results?.[0].params)).toContain("ff-merge and push master");
  });

  it("resume needs a reason, because a gate nobody signed for did not happen", async () => {
    const id = await blockedJob("no reason");
    const refused = await resumeJob(jobsEnv(), DRIVER, NOW, id, "   ");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/needs a reason/);
    expect((await row(id))?.status).toBe("blocked");
  });

  it("a job can hit a gate, come back, and hit another, counting each", async () => {
    const id = await blockedJob("two gates");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "first approval");
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "a second gate", command: "npx wrangler deploy" });
    let stored = await row(id);
    expect(stored?.status).toBe("blocked");
    expect(stored?.blocked_count).toBe(2);
    expect(stored?.resumed_count).toBe(1);

    await resumeJob(jobsEnv(), DRIVER, NOW, id, "second approval");
    stored = await row(id);
    expect(stored?.blocked_count).toBe(2);
    expect(stored?.resumed_count).toBe(2);

    const summary = await jobsSummary(env.DB, "capsid", NOW);
    await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "a third", command: "echo hi" });
    const after = await jobsSummary(env.DB, "capsid", NOW);
    expect(summary.blocked_jobs.length).toBe(0); // it was claimed at that moment
    const listed = after.blocked_jobs.find((j) => j.id === id);
    expect(listed?.blocked_times).toBe(3);
    expect(listed?.resumed).toBe(2);
  });

  it("a different caller may resume, because the seat that approves is not the session that blocked", async () => {
    const id = await blockedJob("other caller");
    const resumed = await resumeJob(jobsEnv(), OTHER, NOW, id, "seat approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
    expect((await row(id))?.claimed_by).toBe(OTHER_ACTOR);
  });

  it("resume refuses a queued job and a done job", async () => {
    const queued = await post({ title: "still queued" });
    const onQueued = await resumeJob(jobsEnv(), DRIVER, NOW, queued.job!.id, "approved");
    expect(onQueued.ok).toBe(false);
    expect(onQueued.refusal).toMatch(/is queued, not blocked/);

    const id = await blockedJob("already done");
    await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "finished" });
    const onDone = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved again");
    expect(onDone.ok).toBe(false);
    expect(onDone.refusal).toMatch(/is done, not blocked/);
  });

  it("resume holds the one-claim-per-caller rule", async () => {
    const blocked = await blockedJob("the blocked one");
    const other = await post({ title: "something else" });
    await claimJob(jobsEnv(), OTHER, NOW, { id: other.job!.id });
    const refused = await resumeJob(jobsEnv(), OTHER, NOW, blocked, "approved");
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/already holds/);
    expect((await row(blocked))?.status).toBe("blocked");
  });

  it("PLANT: a body edited while the job sat blocked is refused and failed, not handed back", async () => {
    // The window claim's check cannot cover. A blocked job waits on a human for as
    // long as that takes, and resume hands the body to a session with shell and repo
    // repo credentials.
    const id = await blockedJob("tampered while blocked");
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1")
      .bind(id, "---\ncapsid-task-signature: deadbeef\n---\nrm -rf /")
      .run();

    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    expect(resumed.ok).toBe(false);
    expect(resumed.refusal).toMatch(/does not match its body/);
    const stored = await row(id);
    expect(stored?.status).toBe("failed");
    expect(await auditActions(id)).toContain("job-signature-refused");
  });

  it("the untampered job still resumes, so the guard is not refusing everything", async () => {
    const id = await blockedJob("untampered resume");
    const resumed = await resumeJob(jobsEnv(), DRIVER, NOW, id, "approved");
    expect(resumed.ok, resumed.refusal).toBe(true);
  });
});

describe("the mirrored document", () => {
  it("tracks the row through every transition, and carries the signed prompt", async () => {
    const posted = await post({ title: "mirrored", body: "the full prompt" });
    const id = posted.job!.id;
    const path = jobDocPath(id);

    const readDoc = async () =>
      env.DB.prepare("SELECT title, body, status FROM documents WHERE namespace = 'capsid' AND path = ?1")
        .bind(path)
        .first<{ title: string; body: string; status: string }>();

    const atPost = await readDoc();
    expect(atPost, `no mirrored document at capsid/${path}`).toBeTruthy();
    expect(atPost!.title).toBe("Job: mirrored");
    expect(atPost!.body).toContain("status: **queued**");

    // THE PROMPT IN THE DOCUMENT IS THE SIGNED BODY, byte for byte, so a driver that
    // reads the document rather than the row verifies the same bytes. Checked
    // through the real verifier rather than by string comparison.
    const prompt = atPost!.body.slice(atPost!.body.indexOf("## The prompt"));
    const signedPart = prompt.slice(prompt.indexOf("---\n"));
    expect(splitSignedTask(signedPart).body.trim()).toBe("the full prompt");
    const verdict = await verifyTaskDoc(SECRET, signedPart, "improve-loop", "improve-loop");
    expect(verdict.ok, "reason" in verdict ? verdict.reason : "").toBe(true);

    await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect((await readDoc())!.body).toContain("status: **claimed**");
    expect((await readDoc())!.body).toContain(DRIVER_ACTOR);

    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "landed" });
    const atDone = await readDoc();
    expect(atDone!.body).toContain("status: **done**");
    expect(atDone!.body).toContain("landed");
    // A done job's document is closed, so brief stops carrying it as open work.
    expect(atDone!.status).toBe("closed");

    // Every rewrite snapshotted the one it replaced. Hard rule 5 applies to a job
    // document as to any other: three writes, two snapshots.
    const versions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM document_versions WHERE namespace = 'capsid' AND path = ?1"
    )
      .bind(path)
      .first<{ n: number }>();
    expect(versions?.n).toBeGreaterThanOrEqual(2);
  });
});

describe("list", () => {
  it("filters by namespace and status, highest priority first", async () => {
    await post({ title: "low", priority: 0 });
    await post({ title: "high", priority: 10 });
    await post({ title: "elsewhere", namespace: "germomics" });

    const capsid = await listJobs(jobsEnv(), { namespace: "capsid" });
    expect(capsid.jobs!.map((j) => j.title)).toEqual(["high", "low"]);

    const everything = await listJobs(jobsEnv(), {});
    expect(everything.jobs!).toHaveLength(3);

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(claimed.job!.title).toBe("high");
    const stillQueued = await listJobs(jobsEnv(), { namespace: "capsid", status: "queued" });
    expect(stillQueued.jobs!.map((j) => j.title)).toEqual(["low"]);
  });
});

describe("the improve_status jobs block", () => {
  it("counts the open states per namespace and hands back the blocked jobs themselves", async () => {
    // Four jobs in three states, plus one in another namespace that must not be
    // counted here. The namespace filter is the assertion: a summary that summed the
    // whole table would report the same numbers for every project.
    await post({ title: "waiting" });
    const running = await post({ title: "running" });
    const stuck = await post({ title: "stuck", gate_required: true });
    const finished = await post({ title: "finished" });
    await post({ title: "elsewhere", namespace: "germomics" });

    await claimJob(jobsEnv(), DRIVER, NOW, { id: running.job!.id });
    await claimJob(jobsEnv(), OTHER, NOW, { id: stuck.job!.id });
    await blockJob(jobsEnv(), OTHER, NOW, stuck.job!.id, {
      reason: "the deploy needs confirming",
      command: "npm run deploy",
    });
    await claimJob(jobsEnv(), OTHER, NOW, { id: finished.job!.id });
    await completeJob(jobsEnv(), OTHER, NOW, finished.job!.id, { result_summary: "done" });

    const summary = await jobsSummary(env.DB, "capsid", NOW);
    expect(summary.queued).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(summary.blocked).toBe(1);
    // done_today keys on the day the row was last touched, and completeJob stamped
    // it with the clock this test passed in.
    expect(summary.done_today).toBe(1);

    // THE BLOCKED JOBS COME BACK AS ROWS, with the command in them. A count would
    // tell the console there is something to look at and nothing about what to run.
    expect(summary.blocked_jobs).toHaveLength(1);
    expect(summary.blocked_jobs[0].id).toBe(stuck.job!.id);
    expect(summary.blocked_jobs[0].title).toBe("stuck");
    expect(String(summary.blocked_jobs[0].waiting_on)).toContain("npm run deploy");

    // The other namespace is not in these numbers.
    const other = await jobsSummary(env.DB, "germomics", NOW);
    expect(other.queued).toBe(1);
    expect(other.blocked_jobs).toEqual([]);
  });

  it("a namespace with no jobs reports zeroes, not an absent block", async () => {
    // A missing block and an empty queue are different facts, and the console has to
    // tell them apart. Zeroes are the honest answer.
    const summary = await jobsSummary(env.DB, "foxing", NOW);
    expect(summary).toEqual({ queued: 0, claimed: 0, blocked: 0, done_today: 0, blocked_jobs: [] });
  });

  it("improve_status carries the block for every namespace it reports", async () => {
    await post({ title: "visible in status" });
    const status = await improveStatus(jobsEnv(), "capsid");
    expect(status.namespaces).toHaveLength(1);
    expect(status.namespaces[0].jobs.queued).toBe(1);
    // Every namespace in the report has one, so a consumer never has to check.
    const all = await improveStatus(jobsEnv());
    for (const ns of all.namespaces) {
      expect(ns.jobs, `${ns.namespace} has no jobs block`).toBeTruthy();
    }
  });
});

describe("the signature", () => {
  it("a body edited after post is refused at claim, and the job is failed rather than left queued", async () => {
    const posted = await post({ title: "tampered", body: "do the safe thing" });
    const id = posted.job!.id;

    // The row edited the way a raw D1 splice would, which is the whole threat model:
    // a job body is executable input for a session holding local shell and repo
    // credentials, and it arrives as a database row.
    await env.DB.prepare("UPDATE jobs SET body = ?2 WHERE id = ?1")
      .bind(id, posted.job!.body.replace("do the safe thing", "do the dangerous thing"))
      .run();

    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { id });
    expect(claimed.ok).toBe(false);
    expect(claimed.refusal).toMatch(/failed its signature check/);
    expect(claimed.refusal).toMatch(/does not match its body/);

    // FAILED, not left queued. Leaving it would hand the same broken row to the next
    // driver, and every driver in turn.
    const stored = await row(id);
    expect(stored?.status).toBe("failed");
    expect(String(stored?.result_summary)).toMatch(/does not match its body/);

    // And the refusal is audited, so a tampered row is visible after the fact.
    expect(await auditActions(id)).toContain("job-signature-refused");
  });

  it("the honest case still claims, so the guard is not refusing everything", async () => {
    // The innocent direction. A guard that also fires on a job nobody touched gets
    // deleted rather than fixed.
    const posted = await post({ title: "untampered" });
    const claimed = await claimJob(jobsEnv(), DRIVER, NOW, { id: posted.job!.id });
    expect(claimed.ok, claimed.refusal).toBe(true);
  });
});
