import type { Env } from "./env";
import type { Agent } from "./agents";
import { noFlags } from "./agents-schema";
import { BACKUP_STALE_HOURS, healthReport, type HealthReport } from "./health";
import { ciStatus, listRepoTree, repoHistory } from "./github";
import { improveStatus, type StatusReport } from "./improve-run";
import { ROSTER } from "./improve-schema";
import { postJob } from "./jobs";

// ---- the watcher ----------------------------------------------------------------
//
// GROUP 3 OF THE ROLES ARC. A step that looks at the surface every half hour and,
// when something is wrong, POSTS A JOB. That is the whole of it.
//
// WHAT IT CANNOT DO IS THE POINT. It holds no blast-radius flag, it cannot claim a
// job, and it cannot fix anything. A watcher that could act on what it found would be
// an unattended agent deciding at 03:00 what to do about a red default branch, and
// the arc this belongs to exists to put a person at that boundary. So it writes the
// finding down, with the evidence, and something with a name picks it up.
//
// THE DEDUPLICATION IS THE QUEUE'S OWN RULE, not a second mechanism. `post` already
// refuses a duplicate while one job of the same (namespace, title) is open, so a
// finding whose title carries its fingerprint posts once and is refused every half
// hour after that until it clears. Building a separate fingerprint table would be a
// second answer to a question the queue already answers, and the two would disagree.

export const WATCHER_NAME = "watcher";
export const WATCHER_ACTOR = `agent:${WATCHER_NAME}`;

export const WATCHER_CADENCE_KEY = "watcher:cadence-minutes";
export const WATCHER_LAST_KEY = "watcher:last";

// HALF AN HOUR BY DEFAULT, KV-configurable. The tick runs every five minutes, so this
// gates itself the way the skill cycle does: all but one invocation in six returns
// after a single KV read.
export const DEFAULT_CADENCE_MINUTES = 30;

// The floor. Zero or a negative number would run every check on every tick, which is
// the one setting that turns a bounded cost into an unbounded one, so an unusable
// value falls back rather than being obeyed.
export const MIN_CADENCE_MINUTES = 5;

// A blocked job nobody has looked at in a day. Long enough that an ordinary gate
// cleared the same afternoon never trips it.
export const BLOCKED_STALE_HOURS = 24;

// A default branch that has been red this long is not a flake somebody is already
// fixing.
export const CI_RED_HOURS = 2;

// Spend over this fraction of a monthly cap is worth saying out loud before the cap
// stops the loop rather than after.
export const BUDGET_WARN_FRACTION = 0.8;

// How many findings one pass will post. A bound rather than a guess: if every check
// fires at once, the queue gets ten jobs and the rest are found again in half an
// hour, which is better than a tick that posts fifty and times out.
export const MAX_FINDINGS_PER_PASS = 10;

// THE WATCHER'S IDENTITY INSIDE THE WORKER, shaped exactly like the minted `watcher`
// role in scripts/mint-agents.mjs: every namespace, the write grant, `jobs.post` and
// nothing else, no flags. Spelled here because the tick has no bearer token to
// present, and spelled to MATCH rather than to be convenient, so the credential a
// person can mint and the identity the Worker uses are the same authority.
// test/watcher.test.ts derives one from the other and fails if they drift.
export function watcherAgent(): Agent {
  return {
    id: WATCHER_ACTOR,
    name: WATCHER_NAME,
    kind: "cron",
    actor: WATCHER_ACTOR,
    scopes: {
      namespaces: "*",
      repos: [],
      tools: ["jobs", "jobs.post"],
      grants: ["write"],
      flags: noFlags(),
    },
    admin: false,
    row: null,
  };
}

export async function cadenceMinutes(env: Env): Promise<number> {
  try {
    const raw = await env.APP_KV.get(WATCHER_CADENCE_KEY);
    if (raw === null) return DEFAULT_CADENCE_MINUTES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < MIN_CADENCE_MINUTES) return DEFAULT_CADENCE_MINUTES;
    return Math.floor(parsed);
  } catch {
    // An unreadable store means the default, on the rule improve_mode already
    // follows: fall back to the safe value rather than to whatever was last in
    // memory.
    return DEFAULT_CADENCE_MINUTES;
  }
}

export type DueVerdict = { due: true; reason: string } | { due: false; reason: string };

export function passDue(lastIso: string | null, minutes: number, now: Date): DueVerdict {
  if (!lastIso) return { due: true, reason: "the watcher has not run yet." };
  const last = Date.parse(lastIso);
  // A corrupt stamp RUNS the pass rather than blocking it: one extra pass costs a
  // handful of reads, and never running again costs a watcher that silently stopped.
  if (Number.isNaN(last)) return { due: true, reason: `last-run stamp '${lastIso}' does not parse; running rather than blocking.` };
  const elapsed = (now.getTime() - last) / 60000;
  if (elapsed < minutes) return { due: false, reason: `${Math.floor(elapsed)} of ${minutes} minutes since the last pass.` };
  return { due: true, reason: `${Math.floor(elapsed)} minutes since the last pass, cadence is ${minutes}.` };
}

// ---- findings --------------------------------------------------------------------

export interface Finding {
  // STABLE WHILE THE FINDING PERSISTS AND DIFFERENT WHEN IT IS A DIFFERENT PROBLEM.
  // It goes in the title, so the queue's one-open-job-per-title rule is what stops a
  // finding being posted twice.
  fingerprint: string;
  namespace: string;
  title: string;
  body: string;
}

const finding = (namespace: string, fingerprint: string, headline: string, evidence: string[]): Finding => ({
  fingerprint,
  namespace,
  title: `Watcher: ${headline} [${fingerprint}]`,
  body: [
    `The watcher found this at ${new Date().toISOString()} and cannot fix it.`,
    "",
    "## Evidence",
    "",
    ...evidence.map((line) => `- ${line}`),
    "",
    "## What this job is",
    "",
    "A finding, not an instruction. Confirm it is still true before acting: the watcher",
    "reads a surface every half hour and a finding can clear itself between the post and",
    "the claim. If it has cleared, fail this job saying so.",
  ].join("\n"),
});

/** What /health says that should not be true. `masterSha` and `latestMigration` come
 *  from the repo, so this answers "is the deployed Worker the one master describes"
 *  rather than only "is it up". */
export function healthFindings(
  health: HealthReport,
  masterSha: string | null,
  latestMigration: string | null,
  namespace: string
): Finding[] {
  const out: Finding[] = [];
  if (health.status !== "ok") {
    out.push(
      finding(namespace, "health-degraded", "the Worker reports degraded", [
        `status: ${health.status}`,
        `store: d1 ${health.store.d1}, fts ${health.store.fts}`,
        "Every read tool errors while a store probe is failing.",
      ])
    );
  }
  // A SHA COMPARISON IS ONLY MEANINGFUL WHEN BOTH SIDES ARE KNOWN. A null master sha
  // means the repo read failed, and reporting that as drift would be a finding about
  // the watcher rather than about the deploy.
  if (masterSha && health.sha && health.sha !== "unknown" && health.sha !== masterSha) {
    out.push(
      finding(namespace, `deploy-drift-${masterSha.slice(0, 7)}`, "the deployed sha is not master head", [
        `deployed: ${health.sha}`,
        `master: ${masterSha}`,
        "A docs-only push whose deploy failed, or a deploy that never ran, looks exactly like this.",
      ])
    );
  }
  if (health.backup.age_hours !== null && health.backup.age_hours > BACKUP_STALE_HOURS) {
    out.push(
      finding(namespace, "backup-stale", "the last backup is older than the window", [
        `last ok: ${health.backup.last_ok ?? "never"}`,
        `age: ${health.backup.age_hours.toFixed(1)} hours, the window is ${BACKUP_STALE_HOURS}`,
      ])
    );
  }
  if (health.backup.last_ok === null) {
    out.push(
      finding(namespace, "backup-never", "no backup has ever reported success", [
        "/health reports backup.last_ok as null.",
        "The nightly dump can fail every night with no signal but this key.",
      ])
    );
  }
  if (latestMigration && health.schema_version && health.schema_version !== latestMigration) {
    out.push(
      finding(namespace, `schema-behind-${latestMigration}`, "the live schema is not the newest migration", [
        `live: ${health.schema_version}`,
        `newest on master: ${latestMigration}`,
        "A migration that was committed and never applied reads exactly like this.",
      ])
    );
  }
  return out;
}

/** What improve_status says that should not be true. Per namespace, because the job
 *  each finding becomes belongs to the namespace it is about. */
export function statusFindings(status: StatusReport, now: Date): Finding[] {
  const out: Finding[] = [];
  const budget = status.budget;
  for (const key of ["model_usd_month", "actions_minutes_month"] as const) {
    const cap = budget.caps?.[key];
    const spent = key === "model_usd_month" ? budget.spend?.cost_usd : budget.spend?.ci_minutes;
    if (typeof cap !== "number" || cap <= 0 || typeof spent !== "number") continue;
    const fraction = spent / cap;
    if (fraction < BUDGET_WARN_FRACTION) continue;
    out.push(
      finding("capsid", `budget-${key}-${budget.month}`, `${key} is over ${Math.round(BUDGET_WARN_FRACTION * 100)} percent of its cap`, [
        `spent: ${spent} of ${cap} (${Math.round(fraction * 100)} percent)`,
        `month: ${budget.month}`,
        "Said before the cap stops the loop rather than after.",
      ])
    );
  }

  for (const ns of status.namespaces ?? []) {
    // A PAUSE IS NOT A PROBLEM. A human pausing a namespace is the system working, so
    // only the two machine-set reasons are reported: the loop paused itself and
    // nobody has looked.
    if (ns.paused && /budget|drift/i.test(ns.paused)) {
      out.push(
        finding(ns.namespace, `paused-${ns.namespace}`, `${ns.namespace} is paused by the loop itself`, [
          `reason: ${ns.paused}`,
          "A pause key has no TTL, so this stays until a human clears it.",
        ])
      );
    }
  }
  return out;
}

// The headline of a block summary. A blocked job's summary carries the whole resume
// command and can run to a page; a finding wants the first line of it.
function firstLine(text: string | null): string {
  const head = (text ?? "").split("\n")[0].trim();
  return head || "(nothing recorded)";
}

export interface BlockedRow {
  id: string;
  namespace: string;
  title: string;
  result_summary: string | null;
  updated_at: string;
}

/** A blocked job nobody has looked at in a day.
 *
 *  Read from the table rather than from improve_status, because the status report's
 *  blocked_jobs projection carries no timestamp: it answers "what is blocked and on
 *  what command", which is the console's question, not "for how long". Widening that
 *  shape to answer both would put a field on the console that only this reads. */
export function staleBlockedFindings(rows: BlockedRow[], now: Date): Finding[] {
  const out: Finding[] = [];
  for (const row of rows) {
    const since = Date.parse(row.updated_at);
    if (Number.isNaN(since)) continue;
    const hours = (now.getTime() - since) / 3_600_000;
    if (hours < BLOCKED_STALE_HOURS) continue;
    out.push(
      finding(row.namespace, `blocked-${row.id}`, `${row.id} has been blocked for over ${BLOCKED_STALE_HOURS} hours`, [
        `title: ${row.title}`,
        `blocked since: ${row.updated_at} (${hours.toFixed(1)} hours)`,
        `waiting on: ${firstLine(row.result_summary)}`,
      ])
    );
  }
  return out;
}

export async function readStaleBlocked(env: Env, now: Date): Promise<BlockedRow[]> {
  const cutoff = new Date(now.getTime() - BLOCKED_STALE_HOURS * 3_600_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, namespace, title, result_summary, updated_at FROM jobs
     WHERE status = 'blocked' AND updated_at < ?1 ORDER BY updated_at ASC LIMIT 20`
  )
    .bind(cutoff)
    .all<BlockedRow>();
  return results ?? [];
}

export interface CiRun {
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
}

/** A default branch that has been red for longer than a flake. Reads the most recent
 *  COMPLETED run, because a run still in flight is not yet an answer. */
export function ciFindings(namespace: string, runs: CiRun[], now: Date): Finding[] {
  const latest = runs.find((r) => r.status === "completed");
  if (!latest) return [];
  if (latest.conclusion === "success" || latest.conclusion === "skipped" || latest.conclusion === "neutral") return [];
  const since = Date.parse(latest.created_at);
  if (Number.isNaN(since)) return [];
  const hours = (now.getTime() - since) / 3_600_000;
  if (hours < CI_RED_HOURS) return [];
  return [
    finding(namespace, `ci-red-${latest.head_sha.slice(0, 7)}`, `${namespace} CI is red on its default branch`, [
      `conclusion: ${latest.conclusion}`,
      `head sha: ${latest.head_sha}`,
      `red since: ${latest.created_at} (${hours.toFixed(1)} hours)`,
    ]),
  ];
}

// ---- posting and clearing ---------------------------------------------------------

export interface WatcherReport {
  ran: boolean;
  note: string;
  posted: string[];
  cleared: string[];
}

/** The fingerprints of every watcher job still open. A job a driver has already
 *  claimed is left alone: the driver owns it, and closing it underneath would be the
 *  queue losing work. */
export async function openWatcherFingerprints(env: Env): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT id, title FROM jobs WHERE posted_by = ?1 AND status = 'queued'`
  )
    .bind(WATCHER_ACTOR)
    .all<{ id: string; title: string }>();
  const open = new Map<string, string>();
  for (const row of results ?? []) {
    const match = /\[([^\]]+)\]\s*$/.exec(row.title);
    if (match) open.set(match[1], row.id);
  }
  return open;
}

/** A finding that is no longer being found. The job is marked failed with "cleared",
 *  which is the honest word: nobody did the work, the thing stopped being true.
 *
 *  KEYED ON queued, so a job a driver claimed between the read and the write is not
 *  closed underneath it, and RETURNING so the count is of rows this actually moved
 *  rather than of D1's trigger-inflated meta.changes. */
export async function clearFinding(env: Env, id: string, now: Date): Promise<boolean> {
  const won = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', result_summary = ?2, lease_expires = NULL, updated_at = ?3
     WHERE id = ?1 AND status = 'queued' AND posted_by = ?4 RETURNING id`
  )
    .bind(id, "cleared", now.toISOString(), WATCHER_ACTOR)
    .first<{ id: string }>();
  return won !== null;
}

// ---- one pass --------------------------------------------------------------------
//
// THE IO IS INJECTED, so every rule above can be driven without a Worker, a database
// or GitHub. What is left here is the ORDER: gather, clear what is no longer found,
// post what is new. Clearing first matters: a finding that flickers off and on would
// otherwise be refused as a duplicate of the job about to be closed.

export interface PassReaders {
  findings: () => Promise<Finding[]>;
  open: () => Promise<Map<string, string>>;
  clear: (id: string) => Promise<boolean>;
  post: (f: Finding) => Promise<{ ok: boolean; refusal?: string }>;
}

export async function runPass(readers: PassReaders): Promise<{ posted: string[]; cleared: string[] }> {
  const found = await readers.findings();
  const byFingerprint = new Map(found.map((f) => [f.fingerprint, f]));
  const open = await readers.open();

  const cleared: string[] = [];
  for (const [fingerprint, id] of open) {
    if (byFingerprint.has(fingerprint)) continue;
    if (await readers.clear(id)) cleared.push(fingerprint);
  }

  const posted: string[] = [];
  for (const f of found.slice(0, MAX_FINDINGS_PER_PASS)) {
    // ALREADY OPEN IS NOT A FAILURE, it is the deduplication working. The post is
    // skipped rather than attempted-and-refused so the log does not fill with
    // refusals every half hour for as long as a finding persists.
    if (open.has(f.fingerprint)) continue;
    const result = await readers.post(f);
    if (result.ok) posted.push(f.fingerprint);
    else console.error(`WATCHER_POST_REFUSED ${f.fingerprint}: ${result.refusal ?? "no reason given"}`);
  }
  return { posted, cleared };
}

/** The step the five-minute tick calls. Gates on its own cadence first, so all but
 *  one invocation in six returns after a single KV read. */
export async function watcherTick(env: Env, now: Date, gather: () => Promise<Finding[]>): Promise<WatcherReport> {
  const minutes = await cadenceMinutes(env);
  const last = await env.APP_KV.get(WATCHER_LAST_KEY).catch(() => null);
  const due = passDue(last, minutes, now);
  if (!due.due) return { ran: false, note: due.reason, posted: [], cleared: [] };

  const agent = watcherAgent();
  const { posted, cleared } = await runPass({
    findings: gather,
    open: () => openWatcherFingerprints(env),
    clear: (id) => clearFinding(env, id, now),
    post: async (f) =>
      postJob(env, agent, now, {
        namespace: f.namespace,
        title: f.title,
        body: f.body,
        priority: 9,
        // A FINDING IS NOT A GATE. The work it leads to may hit one, and that job
        // blocks then; saying so here would mark every finding as needing a human
        // confirmation before anybody has read it.
        gate_required: false,
      }),
  });

  // THE STAMP IS WRITTEN LAST AND ONLY ON A PASS THAT RAN. A stamp written first
  // would make a throwing pass look like a completed one and skip the next six ticks.
  await env.APP_KV.put(WATCHER_LAST_KEY, now.toISOString());
  return {
    ran: true,
    note: `${due.reason} posted ${posted.length}, cleared ${cleared.length}.`,
    posted,
    cleared,
  };
}

// ---- gathering, against the real surfaces -----------------------------------------
//
// Every read here is wrapped: one failing surface must not stop the others being
// checked. A watcher that goes silent because GitHub was slow is worse than one that
// reports three of its four checks, because silence reads as health.

async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`WATCHER_READ_FAILED ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The newest migration filename on master, which is what the live schema_version is
 *  compared against. Sorted by name, because the files are zero-padded and ordered by
 *  that padding everywhere else in this repo. */
export function newestMigration(names: string[]): string | null {
  const sql = names.filter((n) => n.endsWith(".sql")).sort();
  return sql.length ? sql[sql.length - 1] : null;
}

export async function gatherFindings(env: Env, now: Date): Promise<Finding[]> {
  const out: Finding[] = [];

  const health = await attempt("health", () => healthReport(env));
  if (health) {
    const head = await attempt("master head", async () => {
      const history = await repoHistory(env, "capsid", { limit: 1 });
      const commits = (history as { commits?: Array<{ sha?: string }> }).commits ?? [];
      return commits[0]?.sha ?? null;
    });
    const migrations = await attempt("migrations", async () => {
      const tree = await listRepoTree(env, "capsid", "migrations");
      const entries = (tree as { entries?: Array<{ name?: string }> }).entries ?? [];
      return newestMigration(entries.map((e) => e.name ?? ""));
    });
    out.push(...healthFindings(health, head ?? null, migrations ?? null, "capsid"));
  }

  const status = await attempt("improve_status", () => improveStatus(env));
  if (status) out.push(...statusFindings(status, now));

  const blocked = await attempt("blocked jobs", () => readStaleBlocked(env, now));
  if (blocked) out.push(...staleBlockedFindings(blocked, now));

  for (const namespace of ROSTER) {
    const runs = await attempt(`ci ${namespace}`, async () => {
      const report = await ciStatus(env, namespace, undefined, { limit: 5 });
      return ((report as { runs?: CiRun[] }).runs ?? []) as CiRun[];
    });
    if (runs) out.push(...ciFindings(namespace, runs, now));
  }

  return out;
}
