import type { Env } from "./env";
import { prFacts } from "./job-outcomes";

// ---- the merge-state re-verification path ---------------------------------------
//
// An outcome row records a pull request's merge state at the moment `complete` runs,
// and a driver never merges: it blocks and the seat merges afterwards. So the row is
// always written "opened, not merged" and stays that way, and every driver's record
// undercounts permanently.
//
// The fix is one narrow path that updates one field from GitHub. Everything else on
// an outcome row stays write-once.

// How many rows one sweep re-checks. Bounded because each row costs a GitHub read,
// and a sweep that walked the whole table would spend the Worker's request budget on
// rows whose answer has not changed since yesterday.
export const REVERIFY_PER_SWEEP = 50;

// How far back the sweep looks. A pull request that has been open and unmerged for a
// month is not about to merge silently, and re-reading it forever is how a bounded
// job becomes an unbounded one.
export const REVERIFY_WINDOW_DAYS = 30;

/** One row per pull request the evidence named, written in the same batch as the outcome. */
export function outcomePrStatements(db: D1Database, jobId: string, urls: readonly string[]): D1PreparedStatement[] {
  // Deduplicated here rather than relying on the PRIMARY KEY to reject the second
  // one: a conflict inside a batch aborts the whole batch, and the batch this rides
  // in is the one that writes the outcome.
  const seen = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    statements.push(
      db
        .prepare(
          `INSERT INTO job_outcome_prs (job_id, pr_url, merged, merge_verified_at)
           VALUES (?1, ?2, NULL, NULL) ON CONFLICT (job_id, pr_url) DO NOTHING`
        )
        .bind(jobId, trimmed)
    );
  }
  return statements;
}

/** Extract the pull request URLs a finished job referred to, for a row that stored none. */
export function prUrlsFromJob(job: { result_ref: string | null; result_summary: string | null }): string[] {
  const found = new Set<string>();
  const pattern = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+/g;
  for (const text of [job.result_ref ?? "", job.result_summary ?? ""]) {
    for (const match of text.match(pattern) ?? []) found.add(match);
  }
  return [...found];
}

export interface ReverifyOutcome {
  job_id: string;
  pr_url: string;
  merged: boolean;
  changed: boolean;
}

/**
 * Re-read one pull request and write what GitHub says, for every outcome row that
 * named it.
 *
 * WHAT IT TOUCHES: the join row's merged flag and timestamp, and the outcome's
 * prs_merged recomputed as a COUNT over the join rows rather than incremented. A
 * count cannot drift; an increment run twice can, and this path runs on a merge AND
 * on a sweep, so it will be run twice on the same pull request eventually.
 */
export async function reverifyPr(
  env: Env,
  namespace: string,
  prUrl: string,
  now: Date
): Promise<ReverifyOutcome[]> {
  const rows = await env.DB.prepare("SELECT job_id, merged FROM job_outcome_prs WHERE pr_url = ?1")
    .bind(prUrl)
    .all<{ job_id: string; merged: number | null }>();
  const named = rows.results ?? [];
  if (named.length === 0) return [];

  const facts = await prFacts(env, namespace, prUrl);
  // A read that failed leaves every row exactly as it was. An unreachable GitHub is
  // not evidence that a pull request did not merge.
  if (typeof facts === "string") return [];

  const merged = facts.merged === true;
  const out: ReverifyOutcome[] = [];
  for (const row of named) {
    const before = row.merged;
    await env.DB.batch([
      env.DB
        .prepare("UPDATE job_outcome_prs SET merged = ?3, merge_verified_at = ?4 WHERE job_id = ?1 AND pr_url = ?2")
        .bind(row.job_id, prUrl, merged ? 1 : 0, now.toISOString()),
      // prs_merged is RECOMPUTED from the join rows, and the verified flag goes true
      // because this number is now GitHub's. Nothing else on the row is named.
      env.DB
        .prepare(
          `UPDATE job_outcomes
           SET prs_merged = (SELECT COUNT(*) FROM job_outcome_prs WHERE job_id = ?1 AND merged = 1),
               verified = json_set(verified, '$.prs_merged', json('true'))
           WHERE job_id = ?1`
        )
        .bind(row.job_id),
    ]);
    out.push({ job_id: row.job_id, pr_url: prUrl, merged, changed: before === null || before !== (merged ? 1 : 0) });
  }
  return out;
}

/**
 * The rows a sweep should look at: pull requests never checked, or checked longest
 * ago, belonging to outcomes recorded inside the window and not already known merged.
 */
export async function dueForReverify(
  env: Env,
  now: Date,
  limit = REVERIFY_PER_SWEEP
): Promise<Array<{ job_id: string; pr_url: string; namespace: string }>> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT p.job_id, p.pr_url, o.namespace
     FROM job_outcome_prs p
     JOIN job_outcomes o ON o.job_id = p.job_id
     WHERE (p.merged IS NULL OR p.merged = 0)
       AND o.recorded_at >= ?1
     ORDER BY p.merge_verified_at IS NOT NULL, p.merge_verified_at ASC
     LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ job_id: string; pr_url: string; namespace: string }>();
  return rows.results ?? [];
}

export interface SweepReport {
  checked: number;
  changed: number;
  seeded: number;
}

/**
 * One sweep. Seeds join rows for outcomes that stored none, then re-verifies what is
 * due.
 *
 * THE SEED IS WHY THE BACKFILL NEEDS NO SEPARATE SCRIPT. Rows written before this
 * table existed name their pull requests only in the job's result_ref and summary
 * prose, so the first sweep reads those, records what it finds, and the ordinary
 * re-verification path takes it from there. Every seeded URL is verified against
 * GitHub before anything is counted: a URL scraped out of prose is a claim, and this
 * whole change exists because a claim is not evidence.
 */
export async function reverifySweep(env: Env, now: Date, limit = REVERIFY_PER_SWEEP): Promise<SweepReport> {
  const cutoff = new Date(now.getTime() - REVERIFY_WINDOW_DAYS * 86_400_000).toISOString();
  const unseeded = await env.DB.prepare(
    `SELECT o.job_id, o.namespace, j.result_ref, j.result_summary
     FROM job_outcomes o
     JOIN jobs j ON j.id = o.job_id
     WHERE o.result_kind = 'pr'
       AND o.recorded_at >= ?1
       AND NOT EXISTS (SELECT 1 FROM job_outcome_prs p WHERE p.job_id = o.job_id)
     LIMIT ?2`
  )
    .bind(cutoff, limit)
    .all<{ job_id: string; namespace: string; result_ref: string | null; result_summary: string | null }>();

  let seeded = 0;
  for (const row of unseeded.results ?? []) {
    const urls = prUrlsFromJob(row);
    if (urls.length === 0) continue;
    const statements = outcomePrStatements(env.DB, row.job_id, urls);
    if (statements.length === 0) continue;
    await env.DB.batch(statements);
    seeded += statements.length;
  }

  let checked = 0;
  let changed = 0;
  for (const due of await dueForReverify(env, now, limit)) {
    const results = await reverifyPr(env, due.namespace, due.pr_url, now);
    checked += 1;
    changed += results.filter((r) => r.changed).length;
  }
  return { checked, changed, seeded };
}

// ---- the daily cadence ----------------------------------------------------------

const SWEEP_STAMP_KEY = "outcomes:reverify:last";
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Run a sweep at most once a day, on the five-minute tick.
 *
 * Daily rather than per-tick because the answer changes when a human merges something,
 * which is not a per-five-minute event, and the merge path already handles the case
 * where the Worker itself did the merging. Returns null when it was not due.
 */
export async function sweepIfDue(env: Env, now: Date): Promise<SweepReport | null> {
  let last: string | null = null;
  try {
    last = await env.APP_KV.get(SWEEP_STAMP_KEY);
  } catch {
    // An unreadable stamp runs the sweep. It is bounded and idempotent, so the cost of
    // running it twice is one extra set of GitHub reads, and the cost of never running
    // it is a record that stays wrong.
    last = null;
  }
  if (last) {
    const parsed = Date.parse(last);
    if (!Number.isNaN(parsed) && now.getTime() - parsed < SWEEP_INTERVAL_MS) return null;
  }
  const report = await reverifySweep(env, now);
  await env.APP_KV.put(SWEEP_STAMP_KEY, now.toISOString());
  return report;
}
