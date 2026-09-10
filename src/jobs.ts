import type { Env } from "./env";
import { improveDocStatements, priorDoc } from "./improve-state";
import {
  JOB_LEASE_SECONDS,
  JOBS_ROWS_MAX,
  jobDocPath,
  mintJobId,
  type JobRow,
  type JobStatus,
} from "./jobs-schema";
import { signTaskBody, verifySignedBody } from "./improve-task";

// THE WORK QUEUE. The ruling seat posts a job from a chat; a driver session on a
// machine claims it, does it, and reports back.
//
// EVERY TRANSITION IS A KEYED UPDATE WITH RETURNING, never meta.changes. D1's
// meta.changes is inflated by the FTS5 triggers on documents, and these batches
// carry a document write, so the count would be of the triggers as much as the row.
// The same rule the improve state machine already runs on: `UPDATE ... WHERE status
// = <expected> RETURNING id`, and no row back means somebody else got there first.
//
// THE ROW IS THE SOURCE OF TRUTH FOR STATUS. The mirrored document at
// <namespace>/jobs/<id>.md is rewritten in the SAME BATCH as every transition, so a
// reader who found the job through brief or search sees the state the table holds.
// It is a projection, and its body says so.

const ACTOR_SHAPE = /^(github:|opkey:)/;

export interface JobResult {
  ok: boolean;
  action: string;
  job?: JobRow;
  jobs?: JobRow[];
  truncated?: boolean;
  note?: string;
  refusal?: string;
}

function refuse(action: string, refusal: string): JobResult {
  return { ok: false, action, refusal };
}

const leaseUntil = (now: Date) => new Date(now.getTime() + JOB_LEASE_SECONDS * 1000).toISOString();

// The document a job mirrors to. The prompt is the SIGNED body, byte for byte, so a
// driver that reads the document rather than the row still verifies the same bytes.
function renderJobDoc(job: JobRow): string {
  const lines = [
    `# ${job.title}`,
    "",
    `Job \`${job.id}\` in \`${job.namespace}\`. This document is a PROJECTION of the jobs`,
    "table, which is the source of truth for status. Rewritten on every transition.",
    "",
    `- status: **${job.status}**`,
    `- priority: ${job.priority}`,
    `- gate required: ${job.gate_required ? "yes" : "no"}`,
    `- posted by: ${job.posted_by}`,
    `- claimed by: ${job.claimed_by ?? "(unclaimed)"}`,
    `- lease expires: ${job.lease_expires ?? "(no lease)"}`,
  ];
  if (job.result_summary) lines.push(`- result: ${job.result_summary}`);
  if (job.result_ref) lines.push(`- result ref: ${job.result_ref}`);
  lines.push("", "## The prompt", "", job.body);
  return lines.join("\n");
}

async function mirrorStatements(db: D1Database, job: JobRow, action: string, actor: string) {
  const path = jobDocPath(job.id);
  const prior = await priorDoc(db, job.namespace, path);
  return improveDocStatements(db, {
    namespace: job.namespace,
    path,
    title: `Job: ${job.title}`,
    body: renderJobDoc(job),
    type: "task",
    status: job.status === "done" ? "closed" : "active",
    tags: "jobs",
    prior,
    action,
    actor,
  });
}

function auditStatement(db: D1Database, actor: string, action: string, job: JobRow, params: Record<string, unknown>) {
  return db
    .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(actor, action, job.namespace, jobDocPath(job.id), JSON.stringify({ job_id: job.id, ...params }));
}

async function readJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?1").bind(id).first<JobRow>();
}

// ---- post --------------------------------------------------------------------
//
// THE BODY IS SIGNED AT POST, with the same key and the same envelope as the
// improve loop's task documents (src/improve-task.ts). The driver refuses a job
// whose body does not verify, so a row edited by a raw D1 splice, or a document
// mirrored back over by hand, cannot steer a session that holds local shell and
// repo credentials.
//
// UNCONFIGURED IS A REFUSAL, not a skip. With no IMPROVE_SCORE_SECRET there is no
// key to sign with, and a queue of unsignable jobs is a queue the driver will
// refuse one at a time at 03:00 instead of here.
export async function postJob(
  env: Env,
  actor: string,
  now: Date,
  args: { namespace: string; title: string; body: string; priority?: number; gate_required?: boolean }
): Promise<JobResult> {
  if (!env.IMPROVE_SCORE_SECRET) {
    return refuse(
      "post",
      "job signing is not configured on this Worker (IMPROVE_SCORE_SECRET is unset), so this job could not be signed and no driver would execute it. Refusing rather than queueing work nothing can verify."
    );
  }
  const title = args.title.trim();
  if (!title) return refuse("post", "a job needs a title: it is how the queue refuses a duplicate while one is still open.");
  if (!args.body.trim()) return refuse("post", "a job needs a body. The body is the prompt the driver executes.");

  const signed = await signTaskBody(env.IMPROVE_SCORE_SECRET, args.body);
  const job: JobRow = {
    id: mintJobId(),
    namespace: args.namespace,
    title,
    body: signed,
    priority: args.priority ?? 0,
    status: "queued",
    posted_by: actor,
    claimed_by: null,
    claimed_at: null,
    lease_expires: null,
    result_ref: null,
    result_summary: null,
    gate_required: args.gate_required ? 1 : 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const statements = [
    env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, priority, status, posted_by, gate_required, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?8)`
    ).bind(job.id, job.namespace, job.title, job.body, job.priority, job.posted_by, job.gate_required, job.created_at),
    ...(await mirrorStatements(env.DB, job, "job-posted", actor)),
    auditStatement(env.DB, actor, "job-posted", job, { title: job.title, priority: job.priority, gate_required: job.gate_required }),
  ];
  try {
    await env.DB.batch(statements);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The partial unique index over (namespace, title) where status is queued or
    // claimed. Reported as what it means rather than as the constraint's own text.
    if (/UNIQUE/i.test(message)) {
      return refuse(
        "post",
        `${args.namespace} already has an open job titled '${title}'. Finish or fail that one first, or post this under a different title. Open means queued or claimed.`
      );
    }
    throw err;
  }
  return { ok: true, action: "post", job };
}

// ---- list --------------------------------------------------------------------

export async function listJobs(
  env: Env,
  args: { namespace?: string; status?: JobStatus }
): Promise<JobResult> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (args.namespace) {
    binds.push(args.namespace);
    where.push(`namespace = ?${binds.length}`);
  }
  if (args.status) {
    binds.push(args.status);
    where.push(`status = ?${binds.length}`);
  }
  binds.push(JOBS_ROWS_MAX + 1);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs ${clause} ORDER BY priority DESC, created_at ASC LIMIT ?${binds.length}`
  )
    .bind(...binds)
    .all<JobRow>();
  const rows = results ?? [];
  // One extra row asked for, so "exactly the page" is distinguishable from "there
  // are more". Same shape as every other bounded read here.
  const truncated = rows.length > JOBS_ROWS_MAX;
  return {
    ok: true,
    action: "list",
    jobs: truncated ? rows.slice(0, JOBS_ROWS_MAX) : rows,
    ...(truncated ? { truncated: true, note: `more than ${JOBS_ROWS_MAX} jobs match; narrow by namespace or status.` } : {}),
  };
}

// ---- claim -------------------------------------------------------------------
//
// ONE CLAIM PER CALLER, ACROSS EVERY NAMESPACE. A driver does one job at a time,
// and a second claim means the first is either finished or abandoned; letting a
// caller hold two turns the lease into a suggestion. Checked before the CAS, so the
// refusal names the job already held rather than reporting a lost race.
export async function claimJob(
  env: Env,
  actor: string,
  now: Date,
  args: { namespace?: string; id?: string }
): Promise<JobResult> {
  if (!ACTOR_SHAPE.test(actor)) {
    return refuse("claim", `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against a github: login or an opkey: fingerprint.`);
  }
  const held = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 LIMIT 1")
    .bind(actor)
    .first<JobRow>();
  if (held) {
    return refuse(
      "claim",
      `${actor} already holds ${held.id} ('${held.title}' in ${held.namespace}), leased until ${held.lease_expires}. Complete it, fail it, or block it before claiming another.`
    );
  }

  // Either a named job or the highest-priority queued one in a namespace. The
  // SELECT only picks a candidate; the UPDATE below is what actually claims it, so
  // two drivers reading the same candidate still resolve to one winner.
  let candidate: JobRow | null = null;
  if (args.id) {
    candidate = await readJob(env.DB, args.id);
    if (!candidate) return refuse("claim", `no job ${args.id}.`);
    if (candidate.status !== "queued") {
      return refuse("claim", `${args.id} is ${candidate.status}, not queued${candidate.claimed_by ? ` (held by ${candidate.claimed_by})` : ""}.`);
    }
  } else {
    if (!args.namespace) return refuse("claim", "claim needs a namespace to pick from, or an id to claim.");
    candidate = await env.DB.prepare(
      "SELECT * FROM jobs WHERE namespace = ?1 AND status = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1"
    )
      .bind(args.namespace)
      .first<JobRow>();
    if (!candidate) return refuse("claim", `no queued jobs in ${args.namespace}.`);
  }

  // THE SIGNATURE IS CHECKED BEFORE THE JOB IS HANDED OVER, not by the driver after
  // it has one. A job body is executable input that arrives as a database row, and
  // the driver is a session holding local shell and repo credentials.
  //
  // A body that does not verify was edited after `post` signed it, by a raw splice
  // or by a write that reached the row some other way. That job is FAILED here
  // rather than left queued: leaving it would hand the same broken row to the next
  // driver, and every driver in turn, which is a queue that never drains.
  //
  // The actor check verifyTaskDoc adds for a run document deliberately does NOT
  // apply. Only the loop writes a run doc, so its audit actor is the loop; a job is
  // posted by a human seat, so its actor is that seat. What proves a job went
  // through `post` is that this Worker's key signed it.
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, candidate.body, "job body");
  if (!verdict.ok) {
    await env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = 'queued' RETURNING id`
    )
      .bind(candidate.id, verdict.reason, now.toISOString())
      .first<{ id: string }>();
    const failed = { ...candidate, status: "failed" as const, result_summary: verdict.reason, updated_at: now.toISOString() };
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, failed, "job-signature-refused", actor)),
      auditStatement(env.DB, actor, "job-signature-refused", failed, { reason: verdict.reason }),
    ]);
    return refuse("claim", `${candidate.id} failed its signature check and has been marked failed: ${verdict.reason}`);
  }

  const expires = leaseUntil(now);
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'claimed', claimed_by = ?2, claimed_at = ?3, lease_expires = ?4, updated_at = ?3
     WHERE id = ?1 AND status = 'queued' RETURNING id`
  )
    .bind(candidate.id, actor, now.toISOString(), expires)
    .first<{ id: string }>();
  if (!won) {
    return refuse("claim", `${candidate.id} was claimed by someone else between reading it and taking it. Ask again.`);
  }

  const claimed: JobRow = {
    ...candidate,
    status: "claimed",
    claimed_by: actor,
    claimed_at: now.toISOString(),
    lease_expires: expires,
    updated_at: now.toISOString(),
  };
  await env.DB.batch([
    ...(await mirrorStatements(env.DB, claimed, "job-claimed", actor)),
    auditStatement(env.DB, actor, "job-claimed", claimed, { lease_expires: expires }),
  ]);
  return { ok: true, action: "claim", job: claimed };
}

// ---- the transitions a holder makes -------------------------------------------
//
// heartbeat, complete, fail and block are the same shape: a keyed UPDATE that only
// fires for the CLAIMED job THIS caller holds, so an expired lease that the tick
// already returned to the queue cannot be completed out from under its new owner.
async function holderTransition(
  env: Env,
  actor: string,
  now: Date,
  action: "heartbeat" | "complete" | "fail" | "block",
  id: string,
  patch: { status: JobStatus; result_summary?: string | null; result_ref?: string | null; lease_expires: string | null }
): Promise<JobResult> {
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = ?2, result_summary = COALESCE(?3, result_summary), result_ref = COALESCE(?4, result_ref),
       lease_expires = ?5, updated_at = ?6
     WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?7 RETURNING id`
  )
    .bind(id, patch.status, patch.result_summary ?? null, patch.result_ref ?? null, patch.lease_expires, now.toISOString(), actor)
    .first<{ id: string }>();
  if (!won) {
    const current = await readJob(env.DB, id);
    if (!current) return refuse(action, `no job ${id}.`);
    if (current.status !== "claimed") {
      return refuse(
        action,
        `${id} is ${current.status}, not claimed. ${current.status === "queued" ? "Its lease expired and the tick returned it to the queue; claim it again." : "It has already been finished."}`
      );
    }
    return refuse(action, `${id} is held by ${current.claimed_by}, not by ${actor}.`);
  }
  const job = (await readJob(env.DB, id)) as JobRow;
  await env.DB.batch([
    ...(await mirrorStatements(env.DB, job, `job-${action}`, actor)),
    auditStatement(env.DB, actor, `job-${action}`, job, {
      status: job.status,
      ...(patch.result_summary ? { result_summary: patch.result_summary } : {}),
      ...(patch.result_ref ? { result_ref: patch.result_ref } : {}),
    }),
  ]);
  return { ok: true, action, job };
}

export async function heartbeatJob(env: Env, actor: string, now: Date, id: string): Promise<JobResult> {
  return holderTransition(env, actor, now, "heartbeat", id, { status: "claimed", lease_expires: leaseUntil(now) });
}

export async function completeJob(
  env: Env,
  actor: string,
  now: Date,
  id: string,
  args: { result_summary: string; result_ref?: string }
): Promise<JobResult> {
  if (!args.result_summary?.trim()) {
    return refuse("complete", "complete needs a result_summary. A done job with no summary is a job the seat has to reconstruct from the diff.");
  }
  return holderTransition(env, actor, now, "complete", id, {
    status: "done",
    result_summary: args.result_summary,
    result_ref: args.result_ref ?? null,
    lease_expires: null,
  });
}

export async function failJob(env: Env, actor: string, now: Date, id: string, reason: string): Promise<JobResult> {
  if (!reason?.trim()) return refuse("fail", "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.");
  return holderTransition(env, actor, now, "fail", id, { status: "failed", result_summary: reason, lease_expires: null });
}

// BLOCKED CARRIES THE EXACT COMMAND. A job that hit a gate is not a failure, it is
// work waiting on a human, and the thing the human needs is the command to run, not
// a description of the situation. The console shows these.
export async function blockJob(
  env: Env,
  actor: string,
  now: Date,
  id: string,
  args: { reason: string; command?: string }
): Promise<JobResult> {
  if (!args.reason?.trim()) return refuse("block", "block needs a reason: what gate was hit.");
  const summary = args.command ? `${args.reason}\n\nRun this, then unblock by reposting or claiming again:\n\n    ${args.command}` : args.reason;
  return holderTransition(env, actor, now, "block", id, { status: "blocked", result_summary: summary, lease_expires: null });
}

// ---- the lease sweep ----------------------------------------------------------
//
// Run by the five-minute improve tick. A claim whose lease has expired goes back to
// queued, so a driver that died holds a job for at most JOB_LEASE_SECONDS rather
// than forever. RETURNING, so the tick reports what it actually moved.
//
// The mirror documents are rewritten too, one batch per job: a job that reads
// "claimed by a session that is gone" in brief is the state this sweep exists to
// clear, and leaving the document behind would keep telling that story.
export async function expireJobLeases(env: Env, now: Date): Promise<{ requeued: string[] }> {
  const stamp = now.toISOString();
  const { results } = await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL, lease_expires = NULL, updated_at = ?1
     WHERE status = 'claimed' AND lease_expires IS NOT NULL AND lease_expires < ?1 RETURNING id`
  )
    .bind(stamp)
    .all<{ id: string }>();
  const requeued = (results ?? []).map((r) => r.id);
  for (const id of requeued) {
    const job = await readJob(env.DB, id);
    if (!job) continue;
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, job, "job-lease-expired", "improve-loop")),
      auditStatement(env.DB, "improve-loop", "job-lease-expired", job, { returned_to: "queued" }),
    ]);
  }
  return { requeued };
}

// ---- the improve_status block --------------------------------------------------
//
// Counted per namespace, plus what a human has to look at: the blocked jobs, with
// the command each is waiting on. Blocked is the only status whose ROWS come back
// rather than a count, because a count of blocked jobs tells nobody what to run,
// and the console shows exactly these.
//
// done_today rather than done: a lifetime total only ever goes up and stops being
// information. What the seat wants to know is whether the queue moved today.
export interface JobsSummary {
  queued: number;
  claimed: number;
  blocked: number;
  done_today: number;
  blocked_jobs: Array<{ id: string; title: string; waiting_on: string | null }>;
}

export async function jobsSummary(db: D1Database, namespace: string, now: Date): Promise<JobsSummary> {
  const day = now.toISOString().slice(0, 10);
  const counts = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status IN ('queued', 'claimed', 'blocked') GROUP BY status`
    )
    .bind(namespace)
    .all<{ status: string; n: number }>();
  const byStatus = new Map((counts.results ?? []).map((r) => [r.status, r.n]));
  // substr on the stored timestamp rather than a range: updated_at is written as an
  // ISO string by this module and as datetime('now') by the table default, and the
  // two agree on the first ten characters and nothing else.
  const doneToday = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE namespace = ?1 AND status = 'done' AND substr(updated_at, 1, 10) = ?2`
    )
    .bind(namespace, day)
    .first<{ n: number }>();
  const blocked = await db
    .prepare(
      `SELECT id, title, result_summary FROM jobs
       WHERE namespace = ?1 AND status = 'blocked' ORDER BY updated_at DESC LIMIT 20`
    )
    .bind(namespace)
    .all<{ id: string; title: string; result_summary: string | null }>();
  return {
    queued: byStatus.get("queued") ?? 0,
    claimed: byStatus.get("claimed") ?? 0,
    blocked: byStatus.get("blocked") ?? 0,
    done_today: doneToday?.n ?? 0,
    blocked_jobs: (blocked.results ?? []).map((r) => ({ id: r.id, title: r.title, waiting_on: r.result_summary })),
  };
}
