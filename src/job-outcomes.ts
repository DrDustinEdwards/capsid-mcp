import type { Env } from "./env";
import { ciStatus } from "./github";
import { ghFetch, resolveRepo } from "./github/client";
import type { JobRow } from "./jobs-schema";

// JOBS AS EVIDENCE. One outcome row per finished job, written once, carrying counts
// rather than prose.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: the Worker never stores a driver's count
// for something it could have checked and did not. A driver reports what it did; this
// Worker holds a GitHub App token that reaches every repo in the portfolio, so for
// anything that ended in a pull request the authority is GitHub and the driver's
// number is an opinion. Where a check ran, the stored number is GitHub's and the
// field is marked verified. Where it could not run, the driver's number is stored
// and the field is marked unverified. A reader can always tell which.
//
// AND: NULL IS NOT ZERO. A field nobody reported is null. A field somebody counted
// and found empty is 0. Collapsing those two would make "no driver reports test
// counts" indistinguishable from "no driver adds tests", and the second is a finding.

export const OUTCOME_RESULT_KINDS = ["pr", "doc", "none"] as const;
export type OutcomeResultKind = (typeof OUTCOME_RESULT_KINDS)[number];

// The fields a driver may report. Every one is optional and an omitted field stays
// null all the way to the row.
export interface JobEvidence {
  // Pull request URLs this job produced. The only field that unlocks verification:
  // with a pull request the Worker can ask GitHub for the merge state, the commit
  // count and the files touched, and for the head commit's CI conclusion.
  prs?: string[];
  commits?: number;
  files_changed?: number;
  tests_added?: number;
}

// WHICH FIELDS THE WORKER CHECKED ITSELF. Stored as JSON on the row. A field absent
// from this object was not verified, which is the same thing as false; it is written
// out in full anyway so a reader of the raw row does not have to know that.
export interface VerifiedFields {
  prs_opened: boolean;
  prs_merged: boolean;
  commits: boolean;
  files_changed: boolean;
  ci_green: boolean;
}

export interface JobOutcomeRow {
  job_id: string;
  agent: string;
  namespace: string;
  prs_opened: number | null;
  prs_merged: number | null;
  commits: number | null;
  files_changed: number | null;
  tests_added: number | null;
  ci_green: number | null;
  blocked_count: number;
  resumed_count: number;
  duration_minutes: number | null;
  result_kind: OutcomeResultKind;
  verified: string;
  recorded_at: string;
}

const NOTHING_VERIFIED: VerifiedFields = {
  prs_opened: false,
  prs_merged: false,
  commits: false,
  files_changed: false,
  ci_green: false,
};

// ---- what the row says about itself ------------------------------------------

// DERIVED FROM result_ref, NOT DECLARED. A caller that could declare its own result
// kind would be reporting the one thing the row can work out for itself: `resultRef`
// in src/limits.ts already refuses anything that is neither a document path nor an
// https URL, so the shape is decidable here.
export function resultKindOf(resultRef: string | null | undefined): OutcomeResultKind {
  if (!resultRef) return "none";
  return /^https:\/\//i.test(resultRef) ? "pr" : "doc";
}

// THE FINAL WORKING STRETCH, in whole minutes, and the migration says why it is not
// the job's whole life: `resume` takes a fresh lease and resets claimed_at, so time
// the job spent blocked waiting on a human is excluded. A human taking a day to run
// a command is not the driver being slow.
//
// null rather than 0 when there is no claim timestamp to measure from, and null
// rather than a negative number if the clocks disagree: a duration that ran backwards
// is a fact about the clock, not about the work.
export function durationMinutes(claimedAt: string | null, now: Date): number | null {
  if (!claimedAt) return null;
  const started = Date.parse(claimedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = now.getTime() - started;
  if (elapsed < 0) return null;
  return Math.round(elapsed / 60000);
}

// ---- verification -------------------------------------------------------------

// https://github.com/<owner>/<repo>/pull/<number>, which is what open_pr returns and
// what a driver pastes. Anything else is not a pull request this Worker can ask about
// and is reported as unresolved rather than guessed at.
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

interface PrFacts {
  merged: boolean;
  commits: number;
  changed_files: number;
  head_sha: string;
}

export interface EvidenceVerdict {
  prs_opened: number | null;
  prs_merged: number | null;
  commits: number | null;
  files_changed: number | null;
  tests_added: number | null;
  ci_green: number | null;
  verified: VerifiedFields;
  // Named degradation. A verification that could not run says so rather than
  // reporting an unverified number as though nobody had tried.
  notes: string[];
}

export async function prFacts(env: Env, namespace: string, url: string): Promise<PrFacts | string> {
  const match = PR_URL.exec(url);
  if (!match) return `${url} is not a GitHub pull request URL, so nothing could be verified about it`;
  const [, owner, repo, number] = match;
  // THE NAMESPACE-TO-REPOS MAPPING IS THE AUTHORIZATION BOUNDARY (capsid/conventions.md),
  // so the repo named in the URL is resolved THROUGH it rather than used directly. A
  // driver that could hand this a repo its namespace does not map would be using the
  // outcome recorder as an unaudited read of any repo the App can reach.
  let resolved;
  try {
    resolved = await resolveRepo(env, namespace, `${owner}/${repo}`);
  } catch (err) {
    return `${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const resp = await ghFetch(env, resolved.owner, resolved.repo, `/repos/${resolved.owner}/${resolved.repo}/pulls/${number}`);
  if (!resp.ok) return `${url}: GitHub answered ${resp.status}, so its state could not be read`;
  const pr = (await resp.json()) as {
    merged?: boolean;
    commits?: number;
    changed_files?: number;
    head?: { sha?: string };
  };
  return {
    merged: pr.merged === true,
    commits: typeof pr.commits === "number" ? pr.commits : 0,
    changed_files: typeof pr.changed_files === "number" ? pr.changed_files : 0,
    head_sha: pr.head?.sha ?? "",
  };
}

// CI IS GREEN ONLY WHEN IT HAS FINISHED AND EVERY RUN SUCCEEDED.
//
// Three answers, not two. A sha with no runs, or with a run still going, returns null
// and verified:false, because "CI has not answered yet" is not "CI failed" and
// recording it as a failure would libel the job. Only a completed set of runs is a
// verdict.
//
// `skipped` and `neutral` do not fail: a workflow whose paths filter excluded this
// change did not judge it.
const NOT_A_FAILURE = new Set(["success", "skipped", "neutral"]);

async function ciGreenForSha(env: Env, namespace: string, sha: string): Promise<{ green: boolean | null; note?: string }> {
  if (!sha) return { green: null, note: "the pull request carried no head sha, so CI could not be looked up" };
  let status;
  try {
    status = await ciStatus(env, namespace, undefined, { ref: sha, limit: 20 });
  } catch (err) {
    return { green: null, note: `CI could not be read for ${sha.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const runs = status.runs ?? [];
  if (runs.length === 0) return { green: null, note: `no workflow runs for ${sha.slice(0, 7)}, so CI has nothing to say about it` };
  if (runs.some((r) => r.status !== "completed")) {
    return { green: null, note: `CI for ${sha.slice(0, 7)} has not finished, so it is neither green nor red yet` };
  }
  return { green: runs.every((r) => NOT_A_FAILURE.has(r.conclusion ?? "")) };
}

// EVIDENCE ARRIVES AS AN OBJECT OR AS A JSON STRING, and both are accepted.
//
// WHY. An MCP client caches the tool schema at connect time, so a session that
// connected before `evidence` existed holds a schema without it and its client
// refuses the argument locally, before the Worker ever sees it: the session reports
// the work in prose and the outcome row stores nulls, which is the exact undercount
// this migration's sibling exists to stop. Some clients also flatten an object
// argument to a string rather than dropping it.
//
// Both are the same failure from the Worker's side: a caller that knows what it did
// and cannot say so in the shape asked for. A string that parses to an object is
// accepted; a string that does not parse is REFUSED rather than ignored, because
// silently discarding evidence is how a row ends up saying nothing happened.
export type EvidenceInput = JobEvidence | string | undefined;

export function parseEvidence(input: EvidenceInput): { evidence: JobEvidence | undefined } | { error: string } {
  if (input === undefined) return { evidence: undefined };
  if (typeof input !== "string") return { evidence: input };
  const text = input.trim();
  if (text.length === 0) return { evidence: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `evidence was sent as a string that is not JSON: ${text.slice(0, 120)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "evidence parsed to something that is not an object, so there are no fields to read." };
  }
  const row = parsed as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const value = row[key];
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    // A count that is not a non-negative integer is dropped rather than coerced: a
    // stored 0 would read as "somebody counted and the answer was none".
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const prs = Array.isArray(row.prs) ? row.prs.filter((p): p is string => typeof p === "string") : undefined;
  return {
    evidence: {
      ...(prs && prs.length > 0 ? { prs } : {}),
      ...(num("commits") !== undefined ? { commits: num("commits") } : {}),
      ...(num("files_changed") !== undefined ? { files_changed: num("files_changed") } : {}),
      ...(num("tests_added") !== undefined ? { tests_added: num("tests_added") } : {}),
    },
  };
}

// BEST EFFORT, AND IT NEVER FAILS THE JOB. A driver that finished its work must be
// able to close its job even when GitHub is unreachable: the outcome then records the
// driver's own numbers, marked unverified, with a note saying why. Refusing the
// `complete` instead would leave a lease on a job that is finished, which is worse
// than an unverified count.
export async function verifyEvidence(
  env: Env,
  namespace: string,
  evidence: JobEvidence | undefined
): Promise<EvidenceVerdict> {
  const reported = {
    commits: evidence?.commits ?? null,
    files_changed: evidence?.files_changed ?? null,
    tests_added: evidence?.tests_added ?? null,
  };
  const urls = evidence?.prs ?? [];
  const verdict: EvidenceVerdict = {
    prs_opened: urls.length > 0 ? urls.length : null,
    prs_merged: null,
    ...reported,
    ci_green: null,
    verified: { ...NOTHING_VERIFIED },
    notes: [],
  };
  if (urls.length === 0) return verdict;

  const facts: PrFacts[] = [];
  for (const url of urls) {
    const one = await prFacts(env, namespace, url);
    if (typeof one === "string") verdict.notes.push(one);
    else facts.push(one);
  }

  // PARTIAL VERIFICATION IS NOT VERIFICATION. If any named pull request could not be
  // read, the counts stay the driver's and the flags stay false: a merged count over
  // the subset that happened to resolve is a smaller number presented as a total,
  // which is the one way a count can lie without anybody writing a wrong number.
  if (facts.length !== urls.length) {
    verdict.notes.push(
      `${facts.length} of ${urls.length} named pull requests could be read, so the counts below are the driver's own and are marked unverified.`
    );
    return verdict;
  }

  verdict.prs_opened = facts.length;
  verdict.prs_merged = facts.filter((f) => f.merged).length;
  verdict.commits = facts.reduce((total, f) => total + f.commits, 0);
  verdict.files_changed = facts.reduce((total, f) => total + f.changed_files, 0);
  verdict.verified.prs_opened = true;
  verdict.verified.prs_merged = true;
  verdict.verified.commits = true;
  verdict.verified.files_changed = true;

  // CI on the LAST pull request's head, which is the one a driver opens at the end of
  // its work. Asking about every one of them would be a workflow-run lookup per pull
  // request to answer a single boolean.
  const ci = await ciGreenForSha(env, namespace, facts[facts.length - 1].head_sha);
  if (ci.note) verdict.notes.push(ci.note);
  if (ci.green !== null) {
    verdict.ci_green = ci.green ? 1 : 0;
    verdict.verified.ci_green = true;
  }
  return verdict;
}

// ---- the write ----------------------------------------------------------------

export function outcomeFrom(job: JobRow, verdict: EvidenceVerdict, now: Date): JobOutcomeRow {
  return {
    job_id: job.id,
    // claimed_by at the moment the job ended. COPIED, not joined: a later lease
    // expiry clears that column, and an outcome whose author disappears is not a
    // record. "unattributed" cannot happen through a holder transition, which keys on
    // claimed_by, and is here so the NOT NULL column has no way to be violated.
    agent: job.claimed_by ?? "unattributed",
    namespace: job.namespace,
    prs_opened: verdict.prs_opened,
    prs_merged: verdict.prs_merged,
    commits: verdict.commits,
    files_changed: verdict.files_changed,
    tests_added: verdict.tests_added,
    ci_green: verdict.ci_green,
    blocked_count: job.blocked_count,
    resumed_count: job.resumed_count,
    duration_minutes: durationMinutes(job.claimed_at, now),
    result_kind: resultKindOf(job.result_ref),
    verified: JSON.stringify(verdict.verified),
    recorded_at: now.toISOString(),
  };
}

// ON CONFLICT DO NOTHING, so the FIRST record of a job stands. The primary key is
// what makes one row per job a property of the schema rather than of this function,
// and this clause is what stops a second terminal transition (which should not be
// reachable: complete and fail are keyed updates out of `claimed`) from either
// rewriting the record or aborting the batch that carries the transition itself.
export function outcomeStatement(db: D1Database, row: JobOutcomeRow) {
  return db
    .prepare(
      `INSERT INTO job_outcomes (job_id, agent, namespace, prs_opened, prs_merged, commits, files_changed,
         tests_added, ci_green, blocked_count, resumed_count, duration_minutes, result_kind, verified, recorded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT(job_id) DO NOTHING`
    )
    .bind(
      row.job_id,
      row.agent,
      row.namespace,
      row.prs_opened,
      row.prs_merged,
      row.commits,
      row.files_changed,
      row.tests_added,
      row.ci_green,
      row.blocked_count,
      row.resumed_count,
      row.duration_minutes,
      row.result_kind,
      row.verified,
      row.recorded_at
    );
}
