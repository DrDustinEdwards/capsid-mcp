import type { Env } from "./env";
import { improveDocStatements, priorDoc } from "./improve-state";
import {
  JOB_LEASE_SECONDS,
  JOBS_ROWS_MAX,
  jobDocPath,
  missingForJob,
  mintJobId,
  missingForRecord,
  serializeMinRecord,
  serializeRequiredScopes,
  type JobRow,
  type JobStatus,
  type MinRecord,
  type RequiredScopes,
} from "./jobs-schema";
import type { Agent } from "./agents";
import { signTaskBody, verifySignedBody } from "./improve-task";
import { loadRecordRows, recordFor } from "./agent-record";
import {
  outcomeFrom,
  outcomeStatement,
  verifyEvidence,
  type JobEvidence,
  type JobOutcomeRow,
} from "./job-outcomes";

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

// WHO CAN HOLD A LEASE. migrations/0006 states that claimed_by carries the same shape
// as audit_log.actor, so one query joins a job to what its driver did. A minted agent
// speaks that vocabulary as `agent:<name>` (src/agents-schema.ts, agentActor), and
// the name is UNIQUE in the agents table and never reused, so the string identifies
// exactly one credential forever.
const ACTOR_SHAPE = /^(github:|opkey:|agent:)/;

export interface JobResult {
  ok: boolean;
  action: string;
  job?: JobRow;
  jobs?: JobRow[];
  truncated?: boolean;
  note?: string;
  refusal?: string;
  // THE OUTCOME ROW THIS TRANSITION WROTE, returned so the driver sees what the
  // Worker checked rather than assuming its own numbers were taken. `notes` names
  // every verification that could not run, which is the difference between a count
  // nobody checked and a count nobody tried to check.
  outcome?: { row: JobOutcomeRow; notes: string[] };
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
  // Only once it has happened. A job that has never hit a gate should not carry a
  // line of zeroes explaining that it has not.
  if (job.blocked_count > 0) lines.push(`- gates hit: ${job.blocked_count}, resumed: ${job.resumed_count}`);
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

// THE TRACK-RECORD BAR, CHECKED AT THE CLAIM (migrations/0011).
//
// READ ONLY WHEN A JOB ASKS FOR ONE, which is almost never. The record is computed
// from every outcome row, so making every claim pay for that read to answer a
// question nobody asked would put a table scan in front of the queue's hottest path.
//
// It goes through recordFor, the same function improve_status and the console call,
// so the bar a claim is measured against is the number a human can read on the page.
// `null` for namespaces because the improve-loop columns play no part in this
// comparison and computing them here would attribute a namespace's attempts to
// whichever credential happened to be asking.
async function recordShortfall(db: D1Database, actor: string, job: JobRow): Promise<string | null> {
  if (!job.min_record) return null;
  return missingForRecord(recordFor(actor, await loadRecordRows(db), null), job.min_record);
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
  agent: Agent,
  now: Date,
  args: {
    namespace: string;
    title: string;
    body: string;
    priority?: number;
    gate_required?: boolean;
    required_scopes?: Partial<RequiredScopes>;
    min_record?: MinRecord;
  }
): Promise<JobResult> {
  const actor = agent.actor;
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
    // NULL WHEN NOTHING WAS ASKED FOR, rather than an empty requirement object. The
    // column's meaning is "this job needs something unusual", and a row of empty JSON
    // reads as a requirement nobody can see.
    required_scopes: args.required_scopes?.flags?.length ? serializeRequiredScopes(args.required_scopes) : null,
    // NULL WHEN NO BAR WAS ASKED FOR, on the same reasoning as required_scopes above.
    // A bar of zero is no bar, so it is stored as none rather than as a requirement
    // every agent trivially meets.
    min_record: args.min_record?.prs_merged ? serializeMinRecord(args.min_record) : null,
    blocked_count: 0,
    resumed_count: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const statements = [
    env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, priority, status, posted_by, gate_required, required_scopes, min_record, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?7, ?8, ?9, ?10, ?10)`
    ).bind(
      job.id,
      job.namespace,
      job.title,
      job.body,
      job.priority,
      job.posted_by,
      job.gate_required,
      job.required_scopes,
      job.min_record,
      job.created_at
    ),
    ...(await mirrorStatements(env.DB, job, "job-posted", actor)),
    auditStatement(env.DB, actor, "job-posted", job, {
      title: job.title,
      priority: job.priority,
      gate_required: job.gate_required,
      ...(job.required_scopes ? { required_scopes: job.required_scopes } : {}),
      ...(job.min_record ? { min_record: job.min_record } : {}),
    }),
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
  agent: Agent,
  now: Date,
  args: { namespace?: string; id?: string }
): Promise<JobResult> {
  const actor = agent.actor;
  if (!ACTOR_SHAPE.test(actor)) {
    return refuse("claim", `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against a github: login, an opkey: fingerprint, or an agent: name.`);
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
  // WHAT THIS JOB NEEDS OF THE DRIVER, checked BEFORE the lease is taken. A claim
  // that takes the lease and then refuses has parked the job on a driver that cannot
  // do it, and since a caller holds one claim at a time it has also stopped that
  // driver taking anything else for four hours. The check runs through the one
  // enforcement point, so a job requirement and an agent scope are compared by the
  // same function that decides every tool call.
  const missing = missingForJob(agent, candidate.namespace, candidate.required_scopes);
  if (missing) {
    return refuse(
      "claim",
      `${actor} cannot claim ${candidate.id} ('${candidate.title}'): ${missing} The job stays queued for a driver that can do it.`
    );
  }

  // AND WHAT IT NEEDS OF THE DRIVER'S HISTORY, on the same terms and in the same
  // place: before the lease, so a driver that cannot satisfy the bar is not parked on
  // a job for four hours, and the job stays queued for one that can.
  const shortfall = await recordShortfall(env.DB, actor, candidate);
  if (shortfall) {
    return refuse("claim", `${actor} cannot claim ${candidate.id} ('${candidate.title}'): ${shortfall} The job stays queued for a driver that can do it.`);
  }

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
  agent: Agent,
  now: Date,
  action: "heartbeat" | "complete" | "fail" | "block",
  id: string,
  patch: {
    status: JobStatus;
    result_summary?: string | null;
    result_ref?: string | null;
    lease_expires: string | null;
    // block is the only transition that bumps the gate counter. BOUND AS A NUMBER,
    // not interpolated as a SQL fragment: the statement stays one static string, so
    // test/jobs.test.ts can read that it is keyed and test-integration/
    // query-plans.test.ts can reconstruct it and EXPLAIN it. A statement assembled
    // at runtime is invisible to both.
    bumpBlocked?: boolean;
    // What the driver says this job produced. Verified against GitHub and written
    // into job_outcomes below, on the terminal transitions only.
    evidence?: JobEvidence;
  }
): Promise<JobResult> {
  const actor = agent.actor;
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = ?2, result_summary = COALESCE(?3, result_summary), result_ref = COALESCE(?4, result_ref),
       lease_expires = ?5, updated_at = ?6, blocked_count = blocked_count + ?8
     WHERE id = ?1 AND status = 'claimed' AND claimed_by = ?7 RETURNING id`
  )
    .bind(
      id,
      patch.status,
      patch.result_summary ?? null,
      patch.result_ref ?? null,
      patch.lease_expires,
      now.toISOString(),
      actor,
      patch.bumpBlocked ? 1 : 0
    )
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

  // THE OUTCOME ROW, ON THE TERMINAL TRANSITIONS ONLY. A job that is still running
  // has no outcome to record, and one that reached `done` or `failed` will not
  // transition again: both are keyed updates out of `claimed`, so this runs once per
  // job and the primary key enforces that rather than trusting it.
  //
  // A FAILED JOB GETS A ROW TOO. A driver whose jobs mostly fail is the thing this
  // table exists to make visible, and recording only the successes would produce a
  // record in which every agent looks equally good.
  //
  // VERIFICATION RUNS BEFORE THE BATCH AND CANNOT FAIL THE TRANSITION. The row is
  // already updated by this point; verifyEvidence swallows its own errors and reports
  // them as notes, so an unreachable GitHub costs the verified flags and not the
  // driver's ability to close a finished job.
  let outcome: { row: JobOutcomeRow; notes: string[] } | undefined;
  const statements = [
    ...(await mirrorStatements(env.DB, job, `job-${action}`, actor)),
    auditStatement(env.DB, actor, `job-${action}`, job, {
      status: job.status,
      ...(patch.result_summary ? { result_summary: patch.result_summary } : {}),
      ...(patch.result_ref ? { result_ref: patch.result_ref } : {}),
    }),
  ];
  if (job.status === "done" || job.status === "failed") {
    const verdict = await verifyEvidence(env, job.namespace, patch.evidence);
    const row = outcomeFrom(job, verdict, now);
    outcome = { row, notes: verdict.notes };
    statements.push(outcomeStatement(env.DB, row));
  }
  await env.DB.batch(statements);
  return { ok: true, action, job, ...(outcome ? { outcome } : {}) };
}

export async function heartbeatJob(env: Env, agent: Agent, now: Date, id: string): Promise<JobResult> {
  return holderTransition(env, agent, now, "heartbeat", id, { status: "claimed", lease_expires: leaseUntil(now) });
}

export async function completeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: { result_summary: string; result_ref?: string; evidence?: JobEvidence }
): Promise<JobResult> {
  if (!args.result_summary?.trim()) {
    return refuse("complete", "complete needs a result_summary. A done job with no summary is a job the seat has to reconstruct from the diff.");
  }
  return holderTransition(env, agent, now, "complete", id, {
    status: "done",
    result_summary: args.result_summary,
    result_ref: args.result_ref ?? null,
    lease_expires: null,
    evidence: args.evidence,
  });
}

export async function failJob(env: Env, agent: Agent, now: Date, id: string, reason: string): Promise<JobResult> {
  if (!reason?.trim()) return refuse("fail", "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.");
  return holderTransition(env, agent, now, "fail", id, { status: "failed", result_summary: reason, lease_expires: null });
}

// BLOCKED CARRIES THE EXACT COMMAND. A job that hit a gate is not a failure, it is
// work waiting on a human, and the thing the human needs is the command to run, not
// a description of the situation. The console shows these.
// THE SEAT STEPPING IN, on a job it does not hold.
//
// Every other transition keys on `claimed_by = <caller>`, which is what stops two
// drivers treading on each other. That rule leaves no way to close a job whose driver
// is gone: the machine was turned off, the session died, the work was superseded from
// a chat. The lease expiry returns a claimed job to the queue, and a job stuck in a
// state nobody will finish then sits there being counted.
//
// ADMIN ONLY, and that is the same reasoning resume already carries: "the seat that
// approves is routinely not the session that blocked". `agent.admin` is true for the
// OAuth admin session and a legacy write key and is false for every minted agent, so
// a driver cannot fail another driver's job, which is the thing this must not become.
//
// It refuses a job that is already finished rather than rewriting one, and it says so
// rather than reporting a no-op as success. Keyed UPDATE with RETURNING, and the
// mirror and the audit row ride in the same batch as every other transition.
export async function adminFailJob(env: Env, agent: Agent, now: Date, id: string, reason: string): Promise<JobResult> {
  if (!agent.admin) {
    return refuse(
      "admin-fail",
      `${agent.actor} may only fail a job it holds. Failing somebody else's job is the administrator's call, and a minted agent is deliberately not the administrator.`
    );
  }
  if (!reason?.trim()) return refuse("admin-fail", "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.");
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', result_summary = ?3, lease_expires = NULL, updated_at = ?2
     WHERE id = ?1 AND status IN ('queued', 'claimed', 'blocked') RETURNING id`
  )
    .bind(id, now.toISOString(), reason)
    .first<{ id: string }>();
  if (!won) {
    const current = await readJob(env.DB, id);
    if (!current) return refuse("admin-fail", `no job ${id}.`);
    return refuse("admin-fail", `${id} is already ${current.status}; there is nothing to fail.`);
  }
  const job = (await readJob(env.DB, id)) as JobRow;
  const statements = [
    ...(await mirrorStatements(env.DB, job, "job-admin-fail", agent.actor)),
    auditStatement(env.DB, agent.actor, "job-admin-fail", job, { status: job.status, reason, held_by: job.claimed_by }),
  ];
  // THE OTHER WAY A JOB REACHES A TERMINAL STATE, and it gets a row for the same
  // reason `fail` does: a job the seat had to close because its driver never came
  // back is exactly the kind of ending the record should show.
  //
  // ONLY WHEN SOMEBODY HELD IT. A queued job the seat cancelled was never worked, so
  // there is no agent to attribute it to, and inventing one would put a failure on a
  // credential that had not touched the job. There is no evidence argument here
  // either: the seat calling this did not do the work and cannot report on it.
  if (job.claimed_by) {
    const verdict = await verifyEvidence(env, job.namespace, undefined);
    statements.push(outcomeStatement(env.DB, outcomeFrom(job, verdict, now)));
  }
  await env.DB.batch(statements);
  return { ok: true, action: "admin-fail", job };
}

export async function blockJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  args: { reason: string; command?: string }
): Promise<JobResult> {
  if (!args.reason?.trim()) return refuse("block", "block needs a reason: what gate was hit.");
  const summary = args.command ? `${args.reason}\n\nRun this, then send it back in with jobs action 'resume':\n\n    ${args.command}` : args.reason;
  return holderTransition(env, agent, now, "block", id, {
    status: "blocked",
    result_summary: summary,
    lease_expires: null,
    bumpBlocked: true,
  });
}

// ---- resume --------------------------------------------------------------------
//
// A GATE IS A PAUSE, NOT AN ENDING. Before this, `blocked` was terminal: the only
// way into a claim was from `queued`, so a job the driver stopped at a gate could
// never be picked back up. The human ran the command, the work landed, and the row
// still described the state before the gate, because `claim` refuses anything that
// is not queued. Measured 2026-09-10 on job_1b957927a714, which shipped a commit and
// four pull requests while its own row said the push had not happened.
//
// THE SIGNATURE IS CHECKED AGAIN HERE, and that is not belt-and-braces. `claim`
// verifies the body before handing a job to a driver; a blocked job then sits in the
// table for as long as a human takes, which is exactly the window in which a row
// could be edited. Resume hands that body back to a session holding local shell and
// repo credentials, so it re-verifies on the same terms and marks a tampered job
// failed rather than returning it.
//
// WHO MAY RESUME: any write-grant caller, which the tool layer has already checked
// before this runs. Deliberately not restricted to the original claimer: the point
// is that a HUMAN approved something, and the seat that approves is routinely not
// the session that blocked. The reason is required and lands in the audit row, so
// what was approved is recorded rather than implied.
export async function resumeJob(
  env: Env,
  agent: Agent,
  now: Date,
  id: string,
  reason: string
): Promise<JobResult> {
  const actor = agent.actor;
  if (!ACTOR_SHAPE.test(actor)) {
    return refuse("resume", `'${actor}' is not a caller identity this queue can hold a lease for. A claim is recorded against a github: login, an opkey: fingerprint, or an agent: name.`);
  }
  if (!reason?.trim()) {
    return refuse("resume", "resume needs a reason: what the human approved. A job that came back off a gate with no record of who cleared it is a gate that did not happen.");
  }
  // The same one-claim-per-caller rule the claim path runs on, for the same reason:
  // a resume hands the caller a lease, and a driver holding two has abandoned one.
  const held = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'claimed' AND claimed_by = ?1 LIMIT 1")
    .bind(actor)
    .first<JobRow>();
  if (held) {
    return refuse(
      "resume",
      `${actor} already holds ${held.id} ('${held.title}' in ${held.namespace}), leased until ${held.lease_expires}. Finish it before resuming another.`
    );
  }

  const current = await readJob(env.DB, id);
  if (!current) return refuse("resume", `no job ${id}.`);
  if (current.status !== "blocked") {
    return refuse(
      "resume",
      `${id} is ${current.status}, not blocked. Resume is how a job comes back off a gate; a queued job is claimed and a done or failed one is finished.`
    );
  }

  // RESUME IS A CLAIM, so it asks the same scope question a claim asks. The caller
  // that sends a job back in after a gate is routinely not the one that blocked it,
  // and it ends up holding the lease and doing the rest of the work: a driver that
  // could not have claimed this job must not acquire it by resuming it.
  const missing = missingForJob(agent, current.namespace, current.required_scopes);
  if (missing) {
    return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${missing} It stays blocked for a driver that can finish it.`);
  }
  // RESUME IS A CLAIM, so it asks the record question too. A job whose bar the
  // resuming caller does not meet would otherwise be acquired by resuming it, which
  // is the same escalation the scope check above refuses.
  const resumeShortfall = await recordShortfall(env.DB, actor, current);
  if (resumeShortfall) {
    return refuse("resume", `${actor} cannot resume ${id} ('${current.title}'): ${resumeShortfall} It stays blocked for a driver that can finish it.`);
  }

  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, current.body, "job body");
  if (!verdict.ok) {
    await env.DB.prepare(
      `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
       WHERE id = ?1 AND status = 'blocked' RETURNING id`
    )
      .bind(id, verdict.reason, now.toISOString())
      .first<{ id: string }>();
    const failed = { ...current, status: "failed" as const, result_summary: verdict.reason, updated_at: now.toISOString() };
    await env.DB.batch([
      ...(await mirrorStatements(env.DB, failed, "job-signature-refused", actor)),
      auditStatement(env.DB, actor, "job-signature-refused", failed, { reason: verdict.reason, at: "resume" }),
    ]);
    return refuse("resume", `${id} failed its signature check and has been marked failed: ${verdict.reason}`);
  }

  const expires = leaseUntil(now);
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'claimed', claimed_by = ?2, claimed_at = ?3, lease_expires = ?4,
       resumed_count = resumed_count + 1, updated_at = ?3
     WHERE id = ?1 AND status = 'blocked' RETURNING id`
  )
    .bind(id, actor, now.toISOString(), expires)
    .first<{ id: string }>();
  if (!won) {
    return refuse("resume", `${id} left blocked between reading it and resuming it. Ask again.`);
  }

  const job = (await readJob(env.DB, id)) as JobRow;
  await env.DB.batch([
    ...(await mirrorStatements(env.DB, job, "job-resumed", actor)),
    auditStatement(env.DB, actor, "job-resumed", job, {
      approved: reason,
      lease_expires: expires,
      resumed_count: job.resumed_count,
    }),
  ]);
  return { ok: true, action: "resume", job };
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
  // blocked_times and resumed say how often this job has hit a gate and how often a
  // human sent it back. A job on its third gate reads differently from one that has
  // been stuck at the same gate since it was posted, and the count is what tells
  // them apart.
  blocked_jobs: Array<{ id: string; title: string; waiting_on: string | null; blocked_times: number; resumed: number }>;
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
      `SELECT id, title, result_summary, blocked_count, resumed_count FROM jobs
       WHERE namespace = ?1 AND status = 'blocked' ORDER BY updated_at DESC LIMIT 20`
    )
    .bind(namespace)
    .all<{ id: string; title: string; result_summary: string | null; blocked_count: number; resumed_count: number }>();
  return {
    queued: byStatus.get("queued") ?? 0,
    claimed: byStatus.get("claimed") ?? 0,
    blocked: byStatus.get("blocked") ?? 0,
    done_today: doneToday?.n ?? 0,
    blocked_jobs: (blocked.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      waiting_on: r.result_summary,
      blocked_times: r.blocked_count,
      resumed: r.resumed_count,
    })),
  };
}
