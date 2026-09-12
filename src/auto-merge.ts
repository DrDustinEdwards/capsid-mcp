import type { Env } from "./env";
import { getDefaultBranch, ghFetch, resolveRepo } from "./github/client";
import { managePr } from "./github/refs";
import { improveAudit } from "./improve-state";
import { onRoster, protectedHits } from "./improve-schema";
import { isMoneyPath } from "./scope";
import { verifySignedBody } from "./improve-task";

// ---- the policy document ------------------------------------------------------
//
// WHAT THE WORKER MAY MERGE WITHOUT A HUMAN, and where that list lives. The document
// is capsid/policy/auto-merge.md, signed with the same key and envelope as a task
// document, because it decides whether this Worker may write to a default branch
// that deploys on push. An unsigned or edited policy merges nothing.
//
// THE DOCUMENT NAMES THE CHECKS AND THE CODE ENFORCES THEM. A policy document the
// Worker parsed into predicates would be a configuration language, and a change to it
// would be a code change nobody reviewed as one. So the document carries the version,
// whether the policy is enabled, and which namespaces it covers, and it names every
// check by id. test/auto-merge.test.ts asserts the two agree in both directions, so a
// check added in code and not written down fails the build, and loadMergePolicy
// refuses at run time as well, because the test proves the pair in the repo and the
// document actually lives in the database.
export const AUTO_MERGE_POLICY_PATH = "policy/auto-merge.md";
const POLICY_NAMESPACE = "capsid";

// Every check, in the order evaluated. The order decides only which failure is
// reported first; each one refuses on its own.
export const POLICY_CHECKS = [
  "body_names_job",
  "author_is_driver",
  "base_is_default_branch",
  "ci_green",
  "paths_unprotected",
  "paths_not_money",
  "no_migration_workflow_lockfile",
] as const;

export type PolicyCheck = (typeof POLICY_CHECKS)[number];

export interface MergePolicy {
  version: string;
  enabled: boolean;
  namespaces: string[];
  checks: string[];
}

function field(body: string, name: string): string | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(`- ${name}:`));
  return line ? line.slice(line.indexOf(":") + 1).trim() : null;
}

// A check id as the document writes it: a backticked lowercase name at the head of a
// list item. Matching the backticks rather than any list item keeps the prose around
// the list from being read as policy.
const CHECK_ITEM = /^- `([a-z_]+)`/;

/** Parse the policy body below its frontmatter. Returns the policy or a refusal. */
export function parseMergePolicy(body: string): { policy: MergePolicy } | { error: string } {
  const version = field(body, "version");
  if (!version) {
    return { error: "the policy document names no version. A merge audited against an unnamed policy cannot be traced to what it allowed." };
  }
  const enabled = field(body, "enabled");
  if (enabled === null) return { error: "the policy document does not say whether it is enabled." };
  const namespaces = (field(body, "namespaces") ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (namespaces.length === 0) return { error: "the policy document covers no namespaces, so it authorises nothing." };
  const unknown = namespaces.filter((n) => !onRoster(n));
  if (unknown.length > 0) {
    return {
      error: `the policy names ${unknown.join(", ")}, which is not on the improve roster. A policy cannot widen the set of repos this Worker reaches.`,
    };
  }
  const checks: string[] = [];
  for (const line of body.split("\n")) {
    const match = CHECK_ITEM.exec(line.trim());
    if (match) checks.push(match[1]);
  }
  return { policy: { version, enabled: enabled.toLowerCase() === "true", namespaces, checks } };
}

/** Read and verify the policy. A missing, unsigned or tampered document merges nothing. */
export async function loadMergePolicy(env: Env): Promise<{ policy: MergePolicy } | { error: string }> {
  const row = await env.DB.prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(POLICY_NAMESPACE, AUTO_MERGE_POLICY_PATH)
    .first<{ body: string | null }>();
  if (!row) return { error: `no merge policy at ${POLICY_NAMESPACE}/${AUTO_MERGE_POLICY_PATH}, so nothing is auto-merged.` };
  const verdict = await verifySignedBody(env.IMPROVE_SCORE_SECRET, row.body ?? "", "merge policy");
  if (!verdict.ok) return { error: verdict.reason };
  const parsed = parseMergePolicy(row.body ?? "");
  if ("error" in parsed) return parsed;
  const missing = POLICY_CHECKS.filter((c) => !parsed.policy.checks.includes(c));
  if (missing.length > 0) {
    return {
      error: `the policy document does not name ${missing.join(", ")}, which this Worker enforces. Refusing rather than merging against a policy that describes less than the code does.`,
    };
  }
  return parsed;
}

// ---- evaluating one pull request ----------------------------------------------

export interface PrFacts {
  number: number;
  repo: string;
  namespace: string;
  baseRef: string;
  defaultBranch: string;
  headSha: string;
  body: string;
  changedPaths: string[];
  // null when no check run has reported, which is NOT green.
  ciConclusion: string | null;
  ciNote: string;
  // Resolved from the job id in the PR body.
  jobId: string | null;
  jobClaimedBy: string | null;
  driverAgent: { name: string; kind: string; revoked: boolean } | null;
}

export type PolicyVerdict =
  | { merge: true; passed: PolicyCheck[] }
  | { merge: false; failed: PolicyCheck; why: string; passed: PolicyCheck[] };

// The job id a driver puts in a PR body. Matched anywhere in the body so the prose
// around it is free.
const JOB_ID_IN_BODY = /\bjob_[0-9a-f]{12}\b/;

export function jobIdFromBody(body: string): string | null {
  return JOB_ID_IN_BODY.exec(body ?? "")?.[0] ?? null;
}

// Named separately from the protected list because the job asks for these three by
// name, and because their consequence is not local: a migration runs against the live
// database, a workflow is what measures the code, and a lockfile decides what gets
// installed and executed. The protected list already covers them; this is the second
// statement of it, so removing a pattern from one list does not quietly open the other.
const MIGRATION_WORKFLOW_LOCKFILE: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|\/)migrations\//i, why: "a migration, which runs against the live database" },
  { pattern: /(^|\/)\.github\/workflows\//i, why: "a workflow, which is what measures the code" },
  {
    pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|deno\.lock)$/i,
    why: "a lockfile, which decides what gets installed and executed",
  },
];

/** The whole policy, as a pure function of facts. Every check refuses on its own. */
export function evaluatePolicy(facts: PrFacts): PolicyVerdict {
  const passed: PolicyCheck[] = [];
  const no = (failed: PolicyCheck, why: string): PolicyVerdict => ({ merge: false, failed, why, passed: [...passed] });

  if (!facts.jobId) {
    return no("body_names_job", "the PR body names no job id, so there is no request this change can be traced back to.");
  }
  passed.push("body_names_job");

  if (!facts.jobClaimedBy) {
    return no("author_is_driver", `the PR body names ${facts.jobId}, but no such job is recorded in this namespace.`);
  }
  if (!facts.driverAgent) {
    return no("author_is_driver", `${facts.jobId} was held by ${facts.jobClaimedBy}, which is not a minted agent. Only a driver agent's work auto-merges.`);
  }
  if (facts.driverAgent.kind !== "driver") {
    return no("author_is_driver", `${facts.driverAgent.name} is kind '${facts.driverAgent.kind}', not a driver.`);
  }
  if (facts.driverAgent.revoked) {
    return no("author_is_driver", `${facts.driverAgent.name} has been revoked, so its open work waits for the seat.`);
  }
  passed.push("author_is_driver");

  if (facts.baseRef !== facts.defaultBranch) {
    return no("base_is_default_branch", `the PR targets '${facts.baseRef}', not the default branch '${facts.defaultBranch}'.`);
  }
  passed.push("base_is_default_branch");

  if (facts.ciConclusion !== "success") {
    return no("ci_green", `CI on ${facts.headSha.slice(0, 7)} is ${facts.ciConclusion ?? "not reported"}: ${facts.ciNote}`);
  }
  passed.push("ci_green");

  const hits = protectedHits(facts.changedPaths);
  if (hits.length > 0) {
    return no("paths_unprotected", `the change touches ${hits.length} protected path(s): ${hits.map((h) => `${h.path} (${h.why})`).join("; ")}.`);
  }
  passed.push("paths_unprotected");

  const money = facts.changedPaths.filter((p) => isMoneyPath(p));
  if (money.length > 0) {
    return no("paths_not_money", `the change touches a billing or payment surface: ${money.join(", ")}.`);
  }
  passed.push("paths_not_money");

  for (const path of facts.changedPaths) {
    for (const { pattern, why } of MIGRATION_WORKFLOW_LOCKFILE) {
      if (pattern.test(path)) return no("no_migration_workflow_lockfile", `${path} is ${why}.`);
    }
  }
  passed.push("no_migration_workflow_lockfile");

  return { merge: true, passed };
}

// ---- gathering the facts ------------------------------------------------------

interface OpenPr {
  number: number;
  body: string | null;
  base: { ref: string };
  head: { sha: string };
}

// Every completed check run must have concluded success, skipped or neutral, and at
// least one must have reported. A PR with no checks is NOT green: it is a PR whose
// workflow never started, which is indistinguishable from one whose workflow was
// removed.
export function ciVerdict(
  runs: Array<{ name: string; status: string; conclusion: string | null }>
): { conclusion: string | null; note: string } {
  if (runs.length === 0) return { conclusion: null, note: "no check run has reported on this commit" };
  const pending = runs.filter((r) => r.status !== "completed");
  if (pending.length > 0) {
    return { conclusion: "pending", note: `${pending.length} check(s) still running: ${pending.map((r) => r.name).join(", ")}` };
  }
  const bad = runs.filter((r) => !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
  if (bad.length > 0) {
    return { conclusion: "failure", note: `${bad.map((r) => `${r.name}=${r.conclusion ?? "null"}`).join(", ")}` };
  }
  return { conclusion: "success", note: `${runs.length} check(s) green` };
}

async function factsForPr(
  env: Env,
  namespace: string,
  owner: string,
  repo: string,
  defaultBranch: string,
  pr: OpenPr
): Promise<PrFacts> {
  const body = pr.body ?? "";
  const jobId = jobIdFromBody(body);

  let jobClaimedBy: string | null = null;
  let driverAgent: PrFacts["driverAgent"] = null;
  if (jobId) {
    const job = await env.DB.prepare("SELECT claimed_by FROM jobs WHERE id = ?1 AND namespace = ?2")
      .bind(jobId, namespace)
      .first<{ claimed_by: string | null }>();
    jobClaimedBy = job?.claimed_by ?? null;
    if (jobClaimedBy?.startsWith("agent:")) {
      const name = jobClaimedBy.slice("agent:".length);
      const row = await env.DB.prepare("SELECT name, kind, revoked_at FROM agents WHERE name = ?1")
        .bind(name)
        .first<{ name: string; kind: string; revoked_at: string | null }>();
      if (row) driverAgent = { name: row.name, kind: row.kind, revoked: row.revoked_at !== null };
    }
  }

  const [filesResp, checksResp] = await Promise.all([
    ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls/${pr.number}/files?per_page=100`),
    ghFetch(env, owner, repo, `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`),
  ]);
  const changedPaths = filesResp.ok ? ((await filesResp.json()) as Array<{ filename: string }>).map((f) => f.filename) : [];
  const checks = checksResp.ok
    ? ((await checksResp.json()) as { check_runs: Array<{ name: string; status: string; conclusion: string | null }> }).check_runs
    : [];
  // A read that failed is not a pass. Both feed checks that refuse on an empty answer:
  // an unreadable file list yields no paths and an unreadable check list yields no
  // runs, and ciVerdict calls no runs not-green.
  const ci = filesResp.ok
    ? ciVerdict(checks)
    : { conclusion: null, note: `the changed-file list could not be read (${filesResp.status}), so this PR is not evaluated` };

  return {
    number: pr.number,
    repo: `${owner}/${repo}`,
    namespace,
    baseRef: pr.base.ref,
    defaultBranch,
    headSha: pr.head.sha,
    body,
    changedPaths,
    ciConclusion: ci.conclusion,
    ciNote: ci.note,
    jobId,
    jobClaimedBy,
    driverAgent,
  };
}

// ---- what the audit row says --------------------------------------------------
//
// Built by a pure function rather than inline at the call site, so what lands in
// audit_log is asserted directly by test/auto-merge.test.ts. An audit row nobody
// checks is a record whose shape drifts silently.

export function declineParams(
  policyVersion: string,
  facts: PrFacts,
  verdict: Extract<PolicyVerdict, { merge: false }>,
  now: Date
): Record<string, unknown> {
  return {
    policy_version: policyVersion,
    repo: facts.repo,
    pr: facts.number,
    head_sha: facts.headSha,
    failed: verdict.failed,
    why: verdict.why,
    passed: verdict.passed,
    at: now.toISOString(),
  };
}

export function mergeParams(
  policyVersion: string,
  facts: PrFacts,
  passed: PolicyCheck[],
  mergeSha: string | null,
  now: Date
): Record<string, unknown> {
  return {
    policy_version: policyVersion,
    repo: facts.repo,
    pr: facts.number,
    head_sha: facts.headSha,
    job: facts.jobId,
    driver: facts.jobClaimedBy,
    merge_sha: mergeSha,
    passed,
    at: now.toISOString(),
  };
}

// ---- the tick step ------------------------------------------------------------

export interface AutoMergeOutcome {
  namespace: string;
  repo: string;
  number: number;
  merged: boolean;
  // The check that refused, for a PR left open.
  failed: string | null;
  why: string | null;
  passed: string[];
}

// WHERE THE AWAITING-SEAT SET LIVES. Rewritten whole on every tick rather than
// appended to, because the tick recomputes the full set of open pull requests each
// time: a PR that a human merged or closed simply stops appearing, with no second
// mechanism needed to expire it. improve_status reads this key rather than calling
// GitHub, so asking for status costs nothing.
export const AWAITING_SEAT_KEY = "improve:awaiting-seat";

export interface AwaitingSeat {
  namespace: string;
  repo: string;
  number: number;
  failed: string;
  why: string;
  at: string;
}

export interface AutoMergeReport {
  ran: boolean;
  note: string;
  policy_version: string | null;
  outcomes: AutoMergeOutcome[];
}

/** One pass over every open PR on every namespace the policy covers. */
export async function autoMergeTick(env: Env, now: Date): Promise<AutoMergeReport> {
  const loaded = await loadMergePolicy(env);
  if ("error" in loaded) return { ran: false, note: loaded.error, policy_version: null, outcomes: [] };
  const policy = loaded.policy;
  if (!policy.enabled) {
    return { ran: false, note: `merge policy ${policy.version} is present and disabled, so nothing is auto-merged.`, policy_version: policy.version, outcomes: [] };
  }

  const outcomes: AutoMergeOutcome[] = [];

  for (const namespace of policy.namespaces) {
    let owner: string;
    let repo: string;
    try {
      ({ owner, repo } = await resolveRepo(env, namespace));
    } catch (err) {
      console.error(`AUTO_MERGE could not resolve ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const defaultBranch = await getDefaultBranch(env, owner, repo);
    const listed = await ghFetch(env, owner, repo, `/repos/${owner}/${repo}/pulls?state=open&per_page=100`);
    if (!listed.ok) {
      console.error(`AUTO_MERGE could not list PRs on ${owner}/${repo} (${listed.status})`);
      continue;
    }
    const prs = (await listed.json()) as OpenPr[];

    for (const pr of prs) {
      const facts = await factsForPr(env, namespace, owner, repo, defaultBranch, pr);
      const verdict = evaluatePolicy(facts);
      if (!verdict.merge) {
        outcomes.push({
          namespace,
          repo: facts.repo,
          number: pr.number,
          merged: false,
          failed: verdict.failed,
          why: verdict.why,
          passed: verdict.passed,
        });
        await env.DB.batch([
          improveAudit(env.DB, "auto-merge-declined", namespace, declineParams(policy.version, facts, verdict, now)),
        ]);
        continue;
      }
      // merge_method "merge" because the policy audits a head sha and a squash would
      // not preserve it on the default branch.
      const result = await managePr(env, namespace, pr.number, "merge", "merge");
      outcomes.push({ namespace, repo: facts.repo, number: pr.number, merged: true, failed: null, why: null, passed: verdict.passed });
      await env.DB.batch([
        improveAudit(
          env.DB,
          "auto-merged",
          namespace,
          mergeParams(policy.version, facts, verdict.passed, (result as { sha?: string }).sha ?? null, now)
        ),
      ]);
    }
  }

  // The full awaiting-seat set, written whole. Written even when it is empty, so a
  // tick that cleared the last one leaves no stale entry behind.
  const awaiting: AwaitingSeat[] = outcomes
    .filter((o) => !o.merged)
    .map((o) => ({
      namespace: o.namespace,
      repo: o.repo,
      number: o.number,
      failed: o.failed ?? "unknown",
      why: o.why ?? "",
      at: now.toISOString(),
    }));
  try {
    await env.APP_KV.put(AWAITING_SEAT_KEY, JSON.stringify(awaiting));
  } catch (err) {
    // A status surface that could not be written does not fail the merges that
    // already happened.
    console.error(`AUTO_MERGE could not record the awaiting-seat set: ${err instanceof Error ? err.message : String(err)}`);
  }

  const merged = outcomes.filter((o) => o.merged).length;
  return {
    ran: true,
    note: `policy ${policy.version}: ${merged} merged, ${outcomes.length - merged} left for the seat`,
    policy_version: policy.version,
    outcomes,
  };
}
