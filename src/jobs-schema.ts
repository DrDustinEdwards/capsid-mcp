import { bytesToHex } from "./encoding";
import { SCOPE_FLAGS, type ScopeFlag } from "./agents-schema";
import type { Agent } from "./agents";
import { checkScope } from "./scope";

// The work queue's vocabulary, in one place so the table, the tool and the driver
// cannot disagree about it.

export const JOB_STATUSES = ["queued", "claimed", "done", "failed", "blocked"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// The states a job can be claimed out of or is still holding a slot in. The partial
// unique index in migrations/0006_jobs.sql names the same two values, and
// test/jobs.test.ts asserts the two agree: a status added here and not there would
// let two open jobs share a title.
export const OPEN_JOB_STATUSES: readonly JobStatus[] = ["queued", "claimed"];

export const JOB_ACTIONS = ["post", "list", "claim", "heartbeat", "complete", "fail", "block", "resume"] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

// FOUR HOURS. Long enough for a driver to do a real job without heartbeating on a
// timer, short enough that a dead session costs one afternoon rather than the queue.
// The driver heartbeats every 15 minutes anyway, so the lease is the backstop for a
// session that died, not the normal renewal path.
export const JOB_LEASE_SECONDS = 4 * 60 * 60;

// Bounded like every other list in this Worker: a page, and a note when there are
// more, so a short list is never mistaken for the whole queue.
export const JOBS_ROWS_MAX = 100;

// Every job is also a document at <namespace>/jobs/<id>.md, so brief and search see
// the queue without anyone calling this tool. The TABLE is the source of truth for
// status; the document is the findable copy and says so in its own body.
export const jobDocPath = (id: string) => `jobs/${id}.md`;

export interface JobRow {
  id: string;
  namespace: string;
  title: string;
  body: string;
  priority: number;
  status: JobStatus;
  posted_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires: string | null;
  result_ref: string | null;
  result_summary: string | null;
  gate_required: number;
  // The scopes this job's work needs of the driver that claims it, as JSON, or null
  // for the jobs that need nothing unusual (migrations/0009).
  required_scopes: string | null;
  // How many times this job has hit a gate, and how many times a human sent it back
  // in. Counted where they happen (migrations/0007_jobs_resume.sql says why neither
  // is derived from the other).
  blocked_count: number;
  resumed_count: number;
  created_at: string;
  updated_at: string;
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

// ---- what a job needs of the driver that claims it ---------------------------
//
// A job may say which scopes its work requires (migrations/0009), and the claim
// refuses a driver that does not hold them. Expressed in the same vocabulary as an
// agent's scopes and checked by the same function, so "what this job needs" and
// "what this agent has" cannot drift into two comparisons.

// FLAGS ONLY, and that is the whole vocabulary on purpose. The write grant and the
// namespace are required of every claim already, so the only thing a job has left to
// declare is blast radius: this work ends in a merge, or a direct commit, or a
// workflow edit. A requirement a job could state and the claim could not act on would
// be documentation pretending to be a check.
export interface RequiredScopes {
  flags: ScopeFlag[];
}

// FAILS OPEN, which is the opposite of parseScopes and deliberately so. A corrupt
// AGENT row must grant nothing, because the cost of getting that wrong is a caller
// doing what it should not. A corrupt JOB requirement must not invent a requirement
// nobody wrote, because the cost of getting THAT wrong is a job stranded in the queue
// behind a refusal no scope change can satisfy. The claim still checks the write
// grant and the namespace either way, which is the floor.
export function parseRequiredScopes(json: string | null | undefined): RequiredScopes {
  const empty: RequiredScopes = { flags: [] };
  if (!json) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return empty;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const record = raw as Record<string, unknown>;
  return {
    flags: Array.isArray(record.flags)
      ? (record.flags.filter((f): f is ScopeFlag => (SCOPE_FLAGS as readonly unknown[]).includes(f)) as ScopeFlag[])
      : [],
  };
}

export function serializeRequiredScopes(required: Partial<RequiredScopes>): string {
  return JSON.stringify({ flags: required.flags ?? [] });
}

// THE CLAIM'S AUTHORIZATION, in one call to the one enforcement point. Returns a
// refusal naming the missing scope, or null.
//
// The write grant and the namespace are checked for EVERY job, requirement or not: a
// claim is a write, and a driver claiming work in a namespace it cannot reach would
// only discover that at its first tool call. The job's own requirements are added on
// top.
export function missingForJob(agent: Agent, namespace: string, requiredScopes: string | null | undefined): string | null {
  const required = parseRequiredScopes(requiredScopes);
  return checkScope(agent, { tool: "jobs", namespace, grant: "write", flags: required.flags });
}

// job_<12 hex>, minted by the Worker. Not an AUTOINCREMENT integer: a job id is
// quoted in chat and in a commit message, and a guessable sequence invites
// addressing a job by arithmetic. 48 bits is collision-free at this volume and the
// PRIMARY KEY refuses one anyway.
//
// bytesToHex, not an inline map: src/encoding.ts owns the byte encodings and
// test/encoding.test.ts fails the build on a second implementation.
export function mintJobId(): string {
  return `job_${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
}
