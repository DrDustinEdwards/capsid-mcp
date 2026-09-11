import { sha256Hex } from "./auth";
import { bytesToHex } from "./encoding";
import type { Env } from "./env";
import {
  BUDGET_KEY,
  DEFAULT_CONDITION,
  DRIVER_LEASE_TTL_SECONDS,
  IMPROVE_MODES,
  MODE_KEY,
  ROSTER,
  RUN_CONDITIONS,
  driverKey,
  isRunCondition,
  pausedKey,
  servedProtectedPaths,
  type BudgetCaps,
  type ImproveMode,
  type RunCondition,
  type ServedProtectedPath,
} from "./improve-schema";
import { verifyAnchors } from "./improve-scores";
import {
  IMPROVE_ACTOR,
  improveAudit,
  pauseNamespace,
  pausedReason,
  readBest,
  readBudget,
  readMode,
} from "./improve-state";
import { verifyTaskDoc } from "./improve-task";
import { SCOPE_FLAGS, parseScopes } from "./agents-schema";
import { loadAgentRecords, type AgentRecord } from "./agent-record";
import { jobsSummary, type JobsSummary } from "./jobs";
import { integrityOf, REPORTS_PREFIX } from "./truth-report";
import {
  checkBudget,
  loadScores,
  openOne,
  openRuns,
  type BudgetStatus,
  type OpenOutcome,
} from "./improve/open";
import { tickRuns, type TickOutcome } from "./improve/tick";

// The barrel. Only what something outside src/improve/ actually imports: src/index.ts
// and src/routes.ts take openRuns, tickRuns and ingestScore, and test/ takes
// checkBudget. A re-export nothing imports is a name the split invented.
export { ingestScore } from "./improve/ingest";
export { checkBudget, openRuns } from "./improve/open";
export { tickRuns } from "./improve/tick";

// WHAT THE DRIVER ASKS BEFORE IT EXECUTES A PLAN. Returns the verification of one
// task document: its signature against the Worker's derived key, and its last
// audit actor against the loop's own actor. Both must hold. Read-only.
export async function verifyTaskDocument(
  env: Env,
  namespace: string,
  path: string
): Promise<{ path: string; namespace: string; ok: boolean; actor: string | null; reason: string | null }> {
  const row = await env.DB
    .prepare("SELECT body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(namespace, path)
    .first<{ body: string | null }>();
  if (!row) {
    return { path, namespace, ok: false, actor: null, reason: `no document at ${namespace}/${path}` };
  }
  const actorRow = await env.DB
    .prepare("SELECT actor FROM audit_log WHERE namespace = ?1 AND path = ?2 ORDER BY id DESC LIMIT 1")
    .bind(namespace, path)
    .first<{ actor: string | null }>();
  const actor = actorRow?.actor ?? null;
  const verdict = await verifyTaskDoc(env.IMPROVE_SCORE_SECRET, row.body ?? "", actor, IMPROVE_ACTOR);
  return { path, namespace, ok: verdict.ok, actor, reason: verdict.ok ? null : verdict.reason };
}

// ---- status -----------------------------------------------------------------

export interface NamespaceStatus {
  namespace: string;
  paused: string | null;
  anchor_pinned: boolean;
  anchor_problem: string | null;
  best: { sha: string; score: number; recorded_at: string } | null;
  last_run: {
    id: string;
    status: string;
    started: string;
    finished: string | null;
    attempts: number;
    kept: number;
    reverts: number;
    cost_usd: number;
    ci_minutes: number;
    condition: string;
    pr_url: string | null;
    note: string | null;
  } | null;
  totals: { runs: number; attempts: number; kept: number; reverts: number; cost_usd: number; ci_minutes: number };
  // THE LATEST TRUTH REPORT for this namespace (2026-09-07). `lint` mode `report`
  // stores one document per namespace per day under reports/, carrying one integrity
  // percentage; this is the read path for it. null means no report has ever been run
  // here, which is NOT an integrity of zero.
  latest_report: { path: string; integrity: number | null; generated: string } | null;
  // THE WORK QUEUE, per namespace. Counts for the three open states plus what moved
  // today, and the BLOCKED JOBS THEMSELVES with the command each is waiting on. A
  // blocked job is not a failure, it is work waiting on a human, and a count of them
  // tells nobody what to run. This is what the console shows.
  jobs: JobsSummary;
}

export interface StatusReport {
  mode: ImproveMode;
  mode_note: string | null;
  // Present only when the caller asked about one task document. The /improve
  // driver passes the path it is about to execute and refuses on ok:false.
  task_verification?: { path: string; namespace: string; ok: boolean; actor: string | null; reason: string | null };
  // Named as an estimate everywhere it appears. See the RATES comment in
  // src/improve-anthropic.ts for why a number here is not a bill.
  cost_note: string;
  // Monthly spend against the KV caps the opener and tick enforce.
  budget: BudgetStatus;
  // THE DETERMINISTIC PATH GUARD'S LIST, SERVED (residual 10). The subscription-mode
  // driver runs on a laptop, outside every guard in this Worker, and had no path
  // monitor. It fetches these and applies them to each attempt's changed paths before
  // any push, through scripts/path-guard.mjs. Served rather than copied so a pattern
  // added to PROTECTED_PATH_PATTERNS is in the next call's response.
  protected_paths: ServedProtectedPath[];
  // THE CREDENTIAL INVENTORY, on the console a driver already reads. An inventory
  // that can only be seen by calling a separate admin-only tool is one nobody looks
  // at, and last_seen only answers "is this credential still in use" if somebody
  // sees it. Revoked rows are included and say so, because dropping them makes
  // "revoked" and "never existed" look the same.
  //
  // What is NOT here: the key (it exists nowhere), the stored verifier, and a row of
  // six booleans per agent. A reader wants the exception, so only the flags an agent
  // HOLDS are listed.
  agents: AgentSummary[];
  namespaces: NamespaceStatus[];
}

export interface AgentSummary {
  name: string;
  kind: string;
  namespaces: "*" | string[];
  grants: string[];
  flags: string[];
  last_seen: string | null;
  revoked_at: string | null;
  // WHAT THIS CREDENTIAL HAS DONE, from job_outcomes. The inventory above says what an
  // agent MAY do; without this it said nothing about what it HAS done, and last_seen
  // only answers "is this still in use". Counts and rates, never a composite score:
  // see src/agent-record.ts for why that line is drawn there.
  record: AgentRecord;
}

async function agentSummaries(db: D1Database): Promise<AgentSummary[]> {
  const { results } = await db
    .prepare("SELECT name, kind, scopes, last_seen, revoked_at FROM agents ORDER BY revoked_at IS NOT NULL, name")
    .all<{ name: string; kind: string; scopes: string; last_seen: string | null; revoked_at: string | null }>();
  const inventory = (results ?? []).map((row) => {
    const scopes = parseScopes(row.scopes);
    return {
      name: row.name,
      kind: row.kind,
      namespaces: scopes.namespaces,
      grants: scopes.grants,
      flags: SCOPE_FLAGS.filter((flag) => scopes.flags[flag]),
      last_seen: row.last_seen,
      revoked_at: row.revoked_at,
    };
  });
  // THREE GROUPED READS FOR THE WHOLE INVENTORY, not three per credential. The
  // aggregation itself is a pure function over the rows, so what it computes is
  // checked against fixtures rather than against a fake that would agree with
  // whatever it was handed.
  const records = await loadAgentRecords(db, inventory);
  return inventory.map((agent) => ({ ...agent, record: records[agent.name] }));
}

export async function improveStatus(env: Env, only?: string, taskPath?: string): Promise<StatusReport> {
  const { mode, reason } = await readMode(env.APP_KV);
  const budget = await checkBudget(env, new Date());
  const namespaces = only ? [only] : [...ROSTER];
  const out: NamespaceStatus[] = [];

  for (const namespace of namespaces) {
    const { doc, refusal } = await loadScores(env, namespace);
    const verification = await verifyAnchors(env.APP_KV, namespace, doc);
    const best = await readBest(env.APP_KV, namespace);
    const last = await env.DB
      .prepare(
        `SELECT id, status, started, finished, attempts, kept, reverts, cost_usd, ci_minutes, condition, pr_url, note
         FROM improve_runs WHERE namespace = ?1 ORDER BY started DESC LIMIT 1`
      )
      .bind(namespace)
      .first<NonNullable<NamespaceStatus["last_run"]>>();
    const totals = await env.DB
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(attempts),0) AS attempts, COALESCE(SUM(kept),0) AS kept,
                COALESCE(SUM(reverts),0) AS reverts, COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(ci_minutes),0) AS ci_minutes
         FROM improve_runs WHERE namespace = ?1`
      )
      .bind(namespace)
      .first<NamespaceStatus["totals"]>();

    const report = await env.DB
      .prepare(
        `SELECT path, body, updated_at FROM documents
         WHERE namespace = ?1 AND path LIKE ?2 AND type = 'reference'
         ORDER BY path DESC LIMIT 1`
      )
      .bind(namespace, `${REPORTS_PREFIX}lint-%`)
      .first<{ path: string; body: string | null; updated_at: string }>();

    out.push({
      namespace,
      paused: await pausedReason(env.APP_KV, namespace),
      anchor_pinned: Boolean(verification.pinned),
      anchor_problem: refusal,
      best: best ? { sha: best.sha, score: best.score, recorded_at: best.recorded_at } : null,
      last_run: last ?? null,
      totals: totals ?? { runs: 0, attempts: 0, kept: 0, reverts: 0, cost_usd: 0, ci_minutes: 0 },
      // ORDER BY path DESC gives the newest date because the filename is ISO-dated and
      // sorts lexically. updated_at would give the most recently REWRITTEN report, and
      // a re-run of an old date is not the latest measurement.
      latest_report: report
        ? { path: `${namespace}/${report.path}`, integrity: integrityOf(report.body), generated: report.updated_at }
        : null,
      jobs: await jobsSummary(env.DB, namespace, new Date()),
    });
  }

  // The driver's gate. Verified against the namespace it was asked about, so a
  // caller cannot ask about one namespace's doc while naming another.
  const task_verification =
    taskPath && only ? await verifyTaskDocument(env, only, taskPath) : undefined;

  return {
    mode,
    mode_note: reason,
    ...(task_verification ? { task_verification } : {}),
    cost_note:
      "cost_usd is an ESTIMATE computed from token counts and published rates, including cache read and write multipliers. It is for sanity-checking, not accounting.",
    budget,
    protected_paths: servedProtectedPaths(),
    agents: await agentSummaries(env.DB),
    namespaces: out,
  };
}

// ---- the manual entry point -------------------------------------------------

export interface ManualResult {
  mode: ImproveMode;
  mode_note: string | null;
  condition: RunCondition;
  dry_run: boolean;
  opened: OpenOutcome[];
  advanced: TickOutcome[];
}

// What Capsid:improve_run calls. dry_run reports exactly what a real run would do
// and changes nothing: no branch, no dispatch, no row, no document.
export async function improveRunManual(
  env: Env,
  now: Date,
  opts: { namespace?: string; dryRun: boolean; condition?: string }
): Promise<ManualResult> {
  const { mode, reason } = await readMode(env.APP_KV);
  // An unrecognised condition is REFUSED rather than silently defaulted. A run labelled
  // 'full' that was asked to be an ablation is a row that lies, and the column exists
  // so the label can be trusted.
  if (opts.condition !== undefined && !isRunCondition(opts.condition)) {
    throw new Error(
      `unknown condition '${opts.condition}'. Valid conditions: ${RUN_CONDITIONS.join(", ")}. Nothing was opened.`
    );
  }
  const condition: RunCondition = opts.condition ?? DEFAULT_CONDITION;
  if (opts.dryRun) {
    const namespaces = opts.namespace ? [opts.namespace] : [...ROSTER];
    const opened: OpenOutcome[] = [];
    for (const ns of namespaces) {
      opened.push(await openOne(env, ns, mode, now, condition, { preview: true }));
    }
    return { mode, mode_note: reason, condition, dry_run: true, opened, advanced: [] };
  }
  const summary = await openRuns(env, now, opts.namespace, condition);
  // One tick immediately, so a hand-run does something visible rather than only
  // creating a row and waiting five minutes for the cron.
  const advanced = await tickRuns(env, now);
  return { mode: summary.mode, mode_note: summary.modeNote, condition, dry_run: false, opened: summary.outcomes, advanced };
}

// THE CONTROL ACTIONS. improve_run's non-run verbs: set the mode, pause or unpause
// namespaces, set the budget caps. Each is a KV write, audited, and READ BACK from KV
// so the caller sees the value that landed rather than the one it asked for.
// improve_status reads the same keys. All of it is write-gated at the tool boundary.
export type ImproveControlResult =
  | { action: "mode"; requested: string; mode: ImproveMode; mode_note: string | null }
  | { action: "pause" | "unpause"; namespaces: string[]; paused: Record<string, string | null> }
  | { action: "budget"; caps: BudgetCaps }
  | {
      action: "claim";
      namespace: string;
      // True only when THIS call took the lease. A refused claim and a release
      // both report false, and `reason` says which.
      held: boolean;
      holder: string | null;
      expires_in_seconds: number | null;
      reason: string | null;
    }
  | {
      action: "mint_operator_key";
      key: string;
      hash: string;
      // The line that goes in OPERATOR_KEY_HASH: `ro:<hash>`. The tier lives on
      // the ENTRY, which is what makes it the operator's decision rather than
      // the caller's.
      entry: string;
      grant: "read-only";
      already_listed: boolean;
      next_step: string;
      command: string;
      warning: string;
    };

export async function improveControl(
  env: Env,
  action: "mode" | "pause" | "unpause" | "budget" | "mint_operator_key" | "claim",
  opts: {
    value?: string;
    namespace?: string;
    reason?: string;
    actions_minutes_month?: number;
    model_usd_month?: number;
    release?: boolean;
  }
): Promise<ImproveControlResult> {
  // MINT A READ-ONLY OPERATOR KEY, stopping one step short of installing it.
  //
  // THE LAST STEP IS MANUAL. This action generates the key and prints the command
  // that would add its hash to OPERATOR_KEY_HASH. It does not run that command and
  // cannot: a Worker that can widen its own authorization list has one that is
  // decorative, and every guard downstream inherits that. Minting is cheap and
  // reversible; installing is the gate, and it stays with a human holding Cloudflare
  // credentials the Worker does not have.
  //
  // The KEY IS RETURNED ONCE and stored nowhere: not in KV, not in a document, and NOT
  // IN THE AUDIT ROW. OPERATOR_KEY_HASH is the verifier, so writing the hash into
  // audit_log would copy the verifier into a table this same key can read. The audit
  // row records that a mint happened, plus a fingerprint.
  if (action === "mint_operator_key") {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // bytesToHex, not an inline map: src/encoding.ts owns the byte encodings and
    // test/encoding.test.ts fails the build on a second implementation. A duplicated
    // crypto-adjacent helper is the copy nobody looked at mishandling the high byte.
    const key = `capsid_${bytesToHex(bytes)}`;
    // THE `ro:` PREFIX GOES ON THE LIST ENTRY, NOT ON THE KEY. src/auth.ts hashes the
    // presented key and compares it against each entry with the prefix stripped, so the
    // tier is a property of what the OPERATOR wrote down. Getting this backwards mints
    // a WRITE key from a helper whose purpose is the read-only tier, which is why the
    // test resolves the minted key through the real verifier.
    const hash = await sha256Hex(key);
    const entry = `ro:${hash}`;
    const existing = (env.OPERATOR_KEY_HASH ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const alreadyListed = existing.includes(entry);
    const next = alreadyListed ? existing : [...existing, entry];
    await env.DB.batch([
      improveAudit(env.DB, "operator-key-minted", null, {
        // A fingerprint, not the hash. Enough to tell two mints apart in the log
        // and useless as a verifier.
        fingerprint: hash.slice(0, 8),
        grant: "read-only",
      }),
    ]);
    return {
      action: "mint_operator_key",
      key,
      hash,
      entry,
      grant: "read-only",
      already_listed: alreadyListed,
      next_step:
        "This key does NOTHING until its hash is in OPERATOR_KEY_HASH. Run the command below from a machine with wrangler and this account. The Worker deliberately cannot do it: a Worker that can widen its own authorization list does not have one.",
      command: `npx wrangler secret put OPERATOR_KEY_HASH
# then paste, on one line:
${next.join(",")}`,
      warning:
        "The key is shown ONCE and is stored nowhere: not in KV, not in a document, and not in the audit row. Copy it now. Lose it and mint another, then remove the stale hash from the list above. Revoke by removing a hash and putting the secret again.",
    };
  }

  // THE DRIVER LEASE (residual 9). Claimed before a subscription-mode run touches a
  // clone, released when it finishes.
  //
  // BEST-EFFORT, AND SAID SO. KV has no compare-and-set, so this is a get then a put
  // with nothing atomic between them, like the backup lease: it stops a second driver
  // started minutes or hours later, not two claims landing in the same millisecond.
  //
  // The TTL is what makes a crashed driver cost one night rather than forever: the
  // release does not run if the session dies, so the key expires on its own.
  if (action === "claim") {
    const target = (opts.namespace ?? "").trim();
    if (!target) throw new Error('claim needs a namespace. Nothing was changed.');
    if (!(ROSTER as readonly string[]).includes(target)) {
      throw new Error(`'${target}' is not on the improve roster (${ROSTER.join(", ")}). Nothing was changed.`);
    }
    const key = driverKey(target);
    if (opts.release === true) {
      await env.APP_KV.delete(key);
      await env.DB.batch([improveAudit(env.DB, "improve-driver-released", target, {})]);
      return { action: "claim", namespace: target, held: false, holder: null, expires_in_seconds: null, reason: "released" };
    }
    const holder = await env.APP_KV.get(key);
    if (holder !== null) {
      // REFUSED, and the holder is NOT overwritten. A claim that took the lease anyway
      // would turn a lock into a log line.
      return {
        action: "claim",
        namespace: target,
        held: false,
        holder,
        expires_in_seconds: null,
        reason: `the driver lease for ${target} is already held (claimed ${holder}). Another /improve session is running, or one died without releasing and the lease expires within ${DRIVER_LEASE_TTL_SECONDS / 3600} hours.`,
      };
    }
    const claimedAt = new Date().toISOString();
    await env.APP_KV.put(key, claimedAt, { expirationTtl: DRIVER_LEASE_TTL_SECONDS });
    await env.DB.batch([improveAudit(env.DB, "improve-driver-claimed", target, { claimed_at: claimedAt })]);
    return {
      action: "claim",
      namespace: target,
      held: true,
      holder: claimedAt,
      expires_in_seconds: DRIVER_LEASE_TTL_SECONDS,
      reason: null,
    };
  }

  if (action === "mode") {
    const value = (opts.value ?? "").trim().toLowerCase();
    if (!(IMPROVE_MODES as readonly string[]).includes(value)) {
      throw new Error(`mode must be one of ${IMPROVE_MODES.join(", ")}; got '${opts.value ?? ""}'. Nothing was changed.`);
    }
    await env.APP_KV.put(MODE_KEY, value);
    await env.DB.batch([improveAudit(env.DB, "improve-mode-set", null, { mode: value })]);
    // Read back through the same resolver the loop uses, so an unexpected stored value
    // surfaces here rather than at 3am.
    const read = await readMode(env.APP_KV);
    return { action: "mode", requested: value, mode: read.mode, mode_note: read.reason };
  }

  if (action === "pause" || action === "unpause") {
    const target = (opts.namespace ?? "").trim();
    if (!target) throw new Error(`${action} needs a namespace, or "all". Nothing was changed.`);
    if (target !== "all" && !(ROSTER as readonly string[]).includes(target)) {
      throw new Error(`'${target}' is not on the improve roster (${ROSTER.join(", ")}) and is not "all". Nothing was changed.`);
    }
    const namespaces = target === "all" ? [...ROSTER] : [target];
    const reason = opts.reason?.trim() || "paused via improve_run";
    const audits = [];
    for (const ns of namespaces) {
      if (action === "pause") await pauseNamespace(env.APP_KV, ns, reason);
      else await env.APP_KV.delete(pausedKey(ns));
      audits.push(improveAudit(env.DB, action === "pause" ? "improve-paused" : "improve-unpaused", ns, action === "pause" ? { reason } : {}));
    }
    await env.DB.batch(audits);
    // Read each pause key back: pause returns the reason, unpause returns null.
    const paused: Record<string, string | null> = {};
    for (const ns of namespaces) paused[ns] = await pausedReason(env.APP_KV, ns);
    return { action, namespaces, paused };
  }

  const { actions_minutes_month, model_usd_month } = opts;
  for (const [label, n] of [["actions_minutes_month", actions_minutes_month], ["model_usd_month", model_usd_month]] as const) {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`budget needs a positive number for ${label}; got ${JSON.stringify(n)}. Nothing was changed.`);
    }
  }
  await env.APP_KV.put(BUDGET_KEY, JSON.stringify({ actions_minutes_month, model_usd_month }));
  await env.DB.batch([improveAudit(env.DB, "improve-budget-set", null, { actions_minutes_month, model_usd_month })]);
  // Read back through readBudget, which applies the same per-field defaulting the
  // loop sees, so the caps returned are the caps the kill switch will enforce.
  const caps = await readBudget(env.APP_KV);
  return { action: "budget", caps };
}
