// WHAT A CREDENTIAL HAS ACTUALLY DONE, from the outcome rows rather than from prose.
//
// COUNTS AND RATES, NEVER A SCORE. A composite number needs a weighting, a weighting
// is an opinion, and an opinion about how far to trust a credential is not something
// a Worker should be computing on a reader's behalf. Every field here is a count with
// a name on it or a rate with a stated denominator, and a reader who wants to know
// whether a driver is behaving reads them and decides. The moment this returns a
// single number, somebody will gate on it, and the gate will be an opinion nobody
// wrote down.
//
// A RATE WITH NO DENOMINATOR IS NULL, NOT ZERO. An agent that has opened no pull
// requests has no merge rate; reporting 0% would put it below an agent that opened
// ten and merged one, which is backwards. Every rate here carries the count it was
// computed from for the same reason.

import { agentActor } from "./agents-schema";

// WHAT THIS MODULE NEEDS TO KNOW ABOUT A CREDENTIAL, and no more. Deliberately NOT
// `AgentSummary` from improve-run.ts: that module builds the summaries and then asks
// for the records, so importing its type here would make the two files import each
// other. Three fields is also the honest statement of the dependency.
export interface RecordSubject {
  name: string;
  kind: string;
  namespaces: "*" | string[];
}

export interface AgentRecord {
  // THE ACTOR STRING this record was built from, so a reader can see what was
  // matched. `agent:<name>` is what jobs.claimed_by and job_outcomes.agent carry.
  actor: string;
  jobs_done: number;
  jobs_failed: number;
  // A job currently sitting at a gate. Read off the jobs table rather than the
  // outcomes, because a blocked job has not ended and so has no outcome row.
  jobs_blocked: number;
  // How many times this agent's jobs hit a gate, and how many times one was sent back
  // in. Totals across finished jobs, not a count of jobs.
  gates_hit: number;
  resumed: number;
  prs_opened: number;
  prs_merged: number;
  // prs_merged / prs_opened, 0 to 1, rounded to three places. null when this agent
  // has opened none.
  pr_merge_rate: number | null;
  // The share of finished jobs whose CI conclusion the Worker actually checked and
  // found green. DENOMINATOR IS ci_checked, not jobs_done: a job that produced no
  // pull request has no CI to be green, and counting it as a miss would punish a
  // documentation job for not having a build.
  ci_checked: number;
  ci_green_rate: number | null;
  // Whole minutes, the median over finished jobs that recorded a duration. Median
  // rather than mean because one job that sat open over a weekend moves a mean and
  // says nothing about the others.
  median_duration_minutes: number | null;
  // THE IMPROVE LOOP'S SIDE OF THE LEDGER, for drivers only. null for every other
  // kind: an attempt belongs to a namespace's runs, and crediting a seat that merely
  // reads there with them would attribute one credential's work to another.
  attempts_kept: number | null;
  attempts_reverted: number | null;
}

// The rows the record is computed from. Grouped reads, one per shape, so the query
// count does not grow with the number of credentials.
export interface RecordRows {
  // One row per finished job, from job_outcomes.
  outcomes: Array<{
    agent: string;
    prs_opened: number | null;
    prs_merged: number | null;
    ci_green: number | null;
    blocked_count: number;
    resumed_count: number;
    duration_minutes: number | null;
    verified: string;
  }>;
  // One row per (claimed_by, status) from jobs, which is where a job that has not
  // ended is visible at all.
  jobs: Array<{ actor: string; status: string; n: number }>;
  // One row per namespace from improve_runs.
  runs: Array<{ namespace: string; kept: number; reverts: number }>;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // An even count averages the two middles and rounds, so the answer stays a whole
  // number of minutes like every other duration here.
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ONLY A VERIFIED FIELD COUNTS TOWARD A RATE.
//
// This is the point of the whole arc. prs_opened and prs_merged are stored whether or
// not the Worker could check them, because an unverified count is still better than
// nothing on the row itself. A RATE is different: it is a claim about a credential
// that a reader will act on, and one built partly from numbers the credential
// reported about itself is a credential grading its own work. So the rates here read
// only the rows whose `verified` object says this Worker checked that field.
function verifiedFields(json: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, boolean>) : {};
  } catch {
    // A corrupt verified column counts as nothing verified, which is the fail-closed
    // direction: it withholds a rate rather than inventing one.
    return {};
  }
}

export function recordFor(actor: string, rows: RecordRows, namespaces: "*" | string[] | null): AgentRecord {
  const mine = rows.outcomes.filter((o) => o.agent === actor);
  const jobsByStatus = (status: string) =>
    rows.jobs.filter((r) => r.actor === actor && r.status === status).reduce((total, r) => total + r.n, 0);

  // Every outcome row carries the counts; only the verified ones feed the rates.
  const prVerified = mine.filter((o) => verifiedFields(o.verified).prs_opened === true);
  const prsOpened = prVerified.reduce((total, o) => total + (o.prs_opened ?? 0), 0);
  const prsMerged = prVerified
    .filter((o) => verifiedFields(o.verified).prs_merged === true)
    .reduce((total, o) => total + (o.prs_merged ?? 0), 0);

  const ciChecked = mine.filter((o) => verifiedFields(o.verified).ci_green === true && o.ci_green !== null);
  const durations = mine.map((o) => o.duration_minutes).filter((d): d is number => typeof d === "number");

  const runs = namespaces === null ? [] : rows.runs.filter((r) => namespaces === "*" || namespaces.includes(r.namespace));

  return {
    actor,
    // DONE AND FAILED COME FROM THE OUTCOME ROWS' SIBLING STATUSES IN `jobs`, not from
    // counting outcomes: an outcome is written for both, so counting them would give
    // one number where the reader wants two.
    jobs_done: jobsByStatus("done"),
    jobs_failed: jobsByStatus("failed"),
    jobs_blocked: jobsByStatus("blocked"),
    gates_hit: mine.reduce((total, o) => total + o.blocked_count, 0),
    resumed: mine.reduce((total, o) => total + o.resumed_count, 0),
    prs_opened: prsOpened,
    prs_merged: prsMerged,
    pr_merge_rate: rate(prsMerged, prsOpened),
    ci_checked: ciChecked.length,
    ci_green_rate: rate(ciChecked.filter((o) => o.ci_green === 1).length, ciChecked.length),
    median_duration_minutes: median(durations),
    attempts_kept: namespaces === null ? null : runs.reduce((total, r) => total + r.kept, 0),
    attempts_reverted: namespaces === null ? null : runs.reduce((total, r) => total + r.reverts, 0),
  };
}

// One record per credential in the inventory. The improve-loop columns are filled for
// drivers and null for everything else, which is what passing `null` for namespaces
// means here.
export function recordsFrom(agents: RecordSubject[], rows: RecordRows): Record<string, AgentRecord> {
  const out: Record<string, AgentRecord> = Object.create(null);
  for (const agent of agents) {
    out[agent.name] = recordFor(agentActor(agent.name), rows, agent.kind === "driver" ? agent.namespaces : null);
  }
  return out;
}

// ---- the queries ---------------------------------------------------------------

export async function loadRecordRows(db: D1Database): Promise<RecordRows> {
  // The outcome rows are read whole rather than aggregated in SQL: the rates need to
  // know which FIELDS of each row were verified, and that lives in a JSON column no
  // GROUP BY can read. One row per finished job is a small table, and reading it here
  // keeps the aggregation a pure function that can be checked against fixtures rather
  // than against a fake that would agree with whatever it was handed.
  const outcomes = await db
    .prepare(
      `SELECT agent, prs_opened, prs_merged, ci_green, blocked_count, resumed_count, duration_minutes, verified
       FROM job_outcomes`
    )
    .all<RecordRows["outcomes"][number]>();
  const jobs = await db
    .prepare(
      `SELECT claimed_by AS actor, status, COUNT(*) AS n FROM jobs
       WHERE claimed_by IS NOT NULL GROUP BY claimed_by, status`
    )
    .all<{ actor: string; status: string; n: number }>();
  const runs = await db
    .prepare(
      `SELECT namespace, COALESCE(SUM(kept),0) AS kept, COALESCE(SUM(reverts),0) AS reverts
       FROM improve_runs GROUP BY namespace`
    )
    .all<{ namespace: string; kept: number; reverts: number }>();
  return { outcomes: outcomes.results ?? [], jobs: jobs.results ?? [], runs: runs.results ?? [] };
}

export async function loadAgentRecords(db: D1Database, agents: RecordSubject[]): Promise<Record<string, AgentRecord>> {
  return recordsFrom(agents, await loadRecordRows(db));
}
