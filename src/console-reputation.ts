import { agentActor } from "./agents-schema";
import type { AgentSummary } from "./improve-run";

// THE REPUTATION PANEL: what each credential has actually done.
//
// COUNTS, NOT SCORES. A score needs a weighting, a weighting is an opinion, and an
// opinion about how much to trust a credential is not something a page should be
// computing on a reader's behalf. Every number here is a row count with a name on
// it, and a reader who wants to know whether a driver is behaving reads the counts
// and decides.
//
// THIS IS THE ONE PLACE THE CONSOLE QUERIES SOMETHING OF ITS OWN, and it is because
// no tool computes it: improve_status serves the inventory (who exists, what scopes,
// last_seen) and says nothing about what any of them did. The aggregation is a pure
// function over rows, so what it computes is checked against fixtures rather than
// against a fake that would agree with whatever it was handed.

export interface ReputationRows {
  // One row per (claimed_by, status) from the jobs table.
  jobs: Array<{ actor: string; status: string; n: number }>;
  prsOpened: Array<{ actor: string; n: number }>;
  prsMerged: Array<{ actor: string; n: number }>;
  // One row per namespace from improve_runs.
  runs: Array<{ namespace: string; kept: number; reverts: number }>;
}

export interface AgentReputation extends AgentSummary {
  jobs_completed: number;
  jobs_failed: number;
  jobs_blocked: number;
  prs_opened: number;
  prs_merged: number;
  // null for every kind except driver: an attempt belongs to the namespace's improve
  // runs, and attributing those to a seat that merely has read access there would be
  // crediting one credential with another's work.
  attempts_kept: number | null;
  attempts_reverted: number | null;
}

function sumBy(rows: Array<{ actor: string; n: number }>, actor: string): number {
  return rows.filter((r) => r.actor === actor).reduce((total, r) => total + r.n, 0);
}

export function reputationFrom(agents: AgentSummary[], rows: ReputationRows): AgentReputation[] {
  return agents.map((agent) => {
    // THE ACTOR STRING, not the name. `agent:<name>` is what jobs.claimed_by and
    // audit_log.actor carry (migrations/0006 states they share a shape), and matching
    // on the bare name would count rows written by a different kind of caller that
    // happened to spell itself the same way.
    const actor = agentActor(agent.name);
    const jobsByStatus = (status: string) =>
      rows.jobs.filter((r) => r.actor === actor && r.status === status).reduce((total, r) => total + r.n, 0);
    const isDriver = agent.kind === "driver";
    const runs = isDriver
      ? rows.runs.filter((r) => agent.namespaces === "*" || agent.namespaces.includes(r.namespace))
      : [];
    return {
      ...agent,
      jobs_completed: jobsByStatus("done"),
      jobs_failed: jobsByStatus("failed"),
      jobs_blocked: jobsByStatus("blocked"),
      prs_opened: sumBy(rows.prsOpened, actor),
      prs_merged: sumBy(rows.prsMerged, actor),
      attempts_kept: isDriver ? runs.reduce((t, r) => t + r.kept, 0) : null,
      attempts_reverted: isDriver ? runs.reduce((t, r) => t + r.reverts, 0) : null,
    };
  });
}

// ---- the queries -------------------------------------------------------------

export async function loadReputation(db: D1Database, agents: AgentSummary[]): Promise<AgentReputation[]> {
  // Four grouped reads rather than a handful per agent: the inventory is small but it
  // grows by one row per credential, and a per-agent loop would grow the query count
  // with it.
  const jobs = await db
    .prepare(
      `SELECT claimed_by AS actor, status, COUNT(*) AS n FROM jobs
       WHERE claimed_by IS NOT NULL GROUP BY claimed_by, status`
    )
    .all<{ actor: string; status: string; n: number }>();
  const prsOpened = await db
    .prepare("SELECT actor, COUNT(*) AS n FROM audit_log WHERE action = 'open_pr' GROUP BY actor")
    .all<{ actor: string; n: number }>();
  // A MERGE IS A manage_pr ROW WHOSE RESULT SAYS IT MERGED. manage_pr also closes,
  // and the audit row's params is the tool's whole result, so the merged flag is what
  // separates the two. Matched as a substring of the stored JSON, which is honest
  // about what it is: a close carries no such key, and a title containing the literal
  // text would have to be inside a params column this Worker wrote itself.
  const prsMerged = await db
    .prepare(
      `SELECT actor, COUNT(*) AS n FROM audit_log
       WHERE action = 'manage_pr' AND params LIKE '%"merged":true%' GROUP BY actor`
    )
    .all<{ actor: string; n: number }>();
  const runs = await db
    .prepare(
      `SELECT namespace, COALESCE(SUM(kept),0) AS kept, COALESCE(SUM(reverts),0) AS reverts
       FROM improve_runs GROUP BY namespace`
    )
    .all<{ namespace: string; kept: number; reverts: number }>();
  return reputationFrom(agents, {
    jobs: jobs.results ?? [],
    prsOpened: prsOpened.results ?? [],
    prsMerged: prsMerged.results ?? [],
    runs: runs.results ?? [],
  });
}
