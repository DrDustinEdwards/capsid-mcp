import { bytesToHex } from "./encoding";

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
