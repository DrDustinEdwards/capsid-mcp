import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { blockJob, claimJob, completeJob, failJob, postJob, resumeJob } from "../src/jobs";
import { improveStatus } from "../src/improve-run";
import { legacyAgent } from "../src/agents";

// JOBS AS EVIDENCE, AGAINST A REAL D1 (migrations/0011).
//
// Here rather than beside the unit tests for the reason test-integration/jobs.test.ts
// already states about the queue: every property below is a property of the DATABASE.
// "Exactly one outcome row per job" is a PRIMARY KEY, and a bar checked at the claim
// is a refusal a real UPDATE either did or did not perform. A fake answering on SQL
// shape would agree with whatever it was asked.

const SECRET = "test-root-secret";
const SEAT = "github:DrDustinEdwards";
const DRIVER_ACTOR = "opkey:aaaabbbbcccc";
const DRIVER = legacyAgent("write", DRIVER_ACTOR);

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-10T12:00:00.000Z");

async function post(over: Record<string, unknown> = {}) {
  return postJob(jobsEnv(), legacyAgent("write", SEAT), NOW, {
    namespace: "capsid",
    title: "a job",
    body: "do the thing",
    ...over,
  } as Parameters<typeof postJob>[3]);
}

async function jobRow(id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function outcomeRow(id: string) {
  return env.DB.prepare("SELECT * FROM job_outcomes WHERE job_id = ?1").bind(id).first<Record<string, unknown>>();
}

async function outcomeCount(id: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_outcomes WHERE job_id = ?1")
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const UNVERIFIED = JSON.stringify({
  prs_opened: false,
  prs_merged: false,
  commits: false,
  files_changed: false,
  ci_green: false,
});

const FULLY_VERIFIED = JSON.stringify({
  prs_opened: true,
  prs_merged: true,
  commits: true,
  files_changed: true,
  ci_green: false,
});

// A record planted directly, which is how a driver acquires a history without this
// suite having to drive GitHub. The verified column is the argument of each test.
async function plantOutcome(jobId: string, opened: number, merged: number, verified: string) {
  await env.DB.prepare(
    `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, blocked_count, resumed_count,
       result_kind, verified, recorded_at)
     VALUES (?1, ?2, 'capsid', ?3, ?4, 0, 0, 'pr', ?5, '2026-09-01')`
  )
    .bind(jobId, DRIVER_ACTOR, opened, merged, verified)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM job_outcomes").run();
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
});

describe("job outcomes", () => {
  it("a completed job gets EXACTLY ONE outcome row, attributed to its holder", async () => {
    const posted = await post({ title: "completes" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    const done = await completeJob(jobsEnv(), DRIVER, at("2026-09-10T13:30:00.000Z"), id, {
      result_summary: "landed",
      result_ref: "capsid/decisions.md",
    });
    expect(done.ok, done.refusal).toBe(true);

    expect(await outcomeCount(id)).toBe(1);
    const row = await outcomeRow(id);
    expect(row?.agent).toBe(DRIVER_ACTOR);
    expect(row?.namespace).toBe("capsid");
    expect(row?.result_kind).toBe("doc");
    expect(row?.duration_minutes).toBe(90);
    // NULL, NOT ZERO. Nothing was reported and nothing was checked, and those are
    // different from a count that came back empty.
    expect(row?.prs_opened).toBeNull();
    expect(row?.tests_added).toBeNull();
    expect(row?.ci_green).toBeNull();
    expect(JSON.parse(String(row?.verified))).toEqual(JSON.parse(UNVERIFIED));
  });

  it("a reported zero is stored as zero, beside a null nobody reported", async () => {
    const posted = await post({ title: "counts zero" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await completeJob(jobsEnv(), DRIVER, NOW, id, {
      result_summary: "no tests needed",
      evidence: { tests_added: 0 },
    });
    const row = await outcomeRow(id);
    expect(row?.tests_added).toBe(0);
    expect(row?.commits).toBeNull();
  });

  it("A FAILED JOB IS RECORDED TOO, because a record of successes only is not a record", async () => {
    const posted = await post({ title: "fails" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await failJob(jobsEnv(), DRIVER, NOW, id, "the approach did not work");
    expect(await outcomeCount(id)).toBe(1);
    expect((await outcomeRow(id))?.result_kind).toBe("none");
  });

  it("a gated job carries its gate counts, and its duration is the LAST stretch", async () => {
    const posted = await post({ title: "gated" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await blockJob(jobsEnv(), DRIVER, at("2026-09-10T12:30:00.000Z"), id, {
      reason: "needs a push",
      command: "git push origin feat/x",
    });
    // A day passes while a human runs the command. That wait is not the driver being
    // slow, which is why resume takes a fresh lease and the duration measures from it.
    await resumeJob(jobsEnv(), DRIVER, at("2026-09-11T12:00:00.000Z"), id, "Dustin ran it");
    await completeJob(jobsEnv(), DRIVER, at("2026-09-11T12:20:00.000Z"), id, { result_summary: "done" });

    const row = await outcomeRow(id);
    expect(row?.duration_minutes).toBe(20);
    expect(row?.blocked_count).toBe(1);
    expect(row?.resumed_count).toBe(1);
  });

  it("PLANT: a second insert for the same job cannot overwrite the first record", async () => {
    // Planted rather than read off the DDL. An outcome that could be rewritten after
    // the fact is not evidence, so the guarantee is exercised against a real insert.
    const posted = await post({ title: "cannot be rewritten" });
    const id = posted.job!.id;
    await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "first" });
    const before = await outcomeRow(id);

    await env.DB.prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, prs_merged, blocked_count, resumed_count,
         result_kind, verified, recorded_at)
       VALUES (?1, 'agent:impostor', 'capsid', 999, 0, 0, 'pr', '{}', '2030-01-01')
       ON CONFLICT(job_id) DO NOTHING`
    )
      .bind(id)
      .run();

    expect(await outcomeCount(id)).toBe(1);
    const after = await outcomeRow(id);
    expect(after?.agent).toBe(before?.agent);
    expect(after?.prs_merged).toBeNull();
  });

  it("PLANT: the bar a job sets on a driver's history is enforced at the CLAIM", async () => {
    const posted = await post({ title: "needs a track record", min_record: { prs_merged: 2 } });
    const id = posted.job!.id;
    expect(posted.job!.min_record).toBe(JSON.stringify({ prs_merged: 2 }));

    // This driver has no record, so it is refused and the job STAYS QUEUED for one
    // that can do it rather than being failed or parked on a four-hour lease.
    const refused = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/at least 2 merged pull requests/);
    expect((await jobRow(id))?.status).toBe("queued");

    // Give it a record the Worker verified. The same claim now succeeds, so the bar
    // is a bar and not a wall.
    await plantOutcome("job_history0001", 2, 2, FULLY_VERIFIED);
    const won = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(won.ok, won.refusal).toBe(true);
    expect(won.job?.id).toBe(id);
  });

  it("an UNVERIFIED merge count does not clear a bar", async () => {
    // What makes the bar mean anything. Otherwise a driver reports its own fifty
    // merges and claims the work reserved for an agent with a record.
    await plantOutcome("job_selfclaim01", 50, 50, UNVERIFIED);
    await post({ title: "still needs a real record", min_record: { prs_merged: 2 } });
    const refused = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toMatch(/has 0/);
  });

  it("a job with no bar is claimed without the record ever being read", async () => {
    await post({ title: "no bar" });
    const won = await claimJob(jobsEnv(), DRIVER, NOW, { namespace: "capsid" });
    expect(won.ok, won.refusal).toBe(true);
  });

  it("improve_status carries a record per credential, and it is counts and rates only", async () => {
    const status = await improveStatus(jobsEnv() as never, "capsid");
    for (const agent of status.agents) {
      expect(agent.record).toBeDefined();
      expect(agent.record.actor).toBe(`agent:${agent.name}`);
      // A rate with no denominator is null, never a zero that would read as a bad
      // record for a credential that has no record.
      for (const rate of [agent.record.pr_merge_rate, agent.record.ci_green_rate]) {
        expect(rate === null || (rate >= 0 && rate <= 1)).toBe(true);
      }
      expect(Object.keys(agent.record).join(" ")).not.toMatch(/score|rating|trust/i);
    }
  });
});
