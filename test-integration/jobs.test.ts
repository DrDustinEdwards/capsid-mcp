import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, completeJob, expireJobLeases, failJob, heartbeatJob, listJobs, postJob } from "../src/jobs";
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
const DRIVER = "opkey:aaaabbbbcccc";
const OTHER = "opkey:ddddeeeeffff";

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
  return postJob(jobsEnv(), SEAT, NOW, {
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
    expect(claimed.job!.claimed_by).toBe(DRIVER);
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
    expect(new Set((actors.results ?? []).map((r) => r.actor))).toEqual(new Set([SEAT, DRIVER]));
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
    expect(stolen.refusal).toMatch(new RegExp(`held by ${DRIVER}, not by ${OTHER}`));
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
    const result = await postJob(unconfigured, SEAT, NOW, { namespace: "capsid", title: "unsignable", body: "x" });
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
    const reclaimed = await claimJob(jobsEnv(), SEAT.replace("github:", "opkey:"), later, { id: dead.job!.id });
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
    expect((await readDoc())!.body).toContain(DRIVER);

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
