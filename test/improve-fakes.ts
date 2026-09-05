// The improve tables, taught to the one D1 fake.
//
// A SEPARATE MODULE, NOT A SECOND FAKE. test/fakes.ts still owns the single
// fakeD1(); this file is the dialect it delegates to when a statement names an
// improve_* table. The rule from quality audit 6.2 is that there is one fake per
// binding, not that one file holds every SQL shape, and folding four more tables
// into the document dialect would have made the file the thing nobody reads.
//
// IT IS ROW-BACKED AND BIND-AWARE, for the reason 6.1 gives: a fake that answers
// on SQL shape alone cannot disagree with the handler, so every assertion becomes
// "the handler issued some statement". Asking for the wrong run id gets nothing
// back here, exactly as D1 would answer.
//
// AND IT THROWS ON A STATEMENT IT DOES NOT RECOGNISE. That is the load-bearing
// property. The alternative, returning an empty result for an unmodelled shape, is
// how a test passes over a query the fake never understood: the handler reads
// nothing, takes its empty-set branch, and the assertion about that branch is
// vacuously true. Every improve statement is either modelled or a loud failure.

export const IMPROVE_RUN_DEFAULTS: Record<string, unknown> = {
  id: "run-1",
  namespace: "capsid",
  mode: "api",
  started: "2026-09-01 08:00:00",
  finished: null,
  attempts: 0,
  kept: 0,
  reverts: 0,
  cost_usd: 0,
  ci_minutes: 0,
  status: "opening",
  consecutive_reverts: 0,
  current_attempt: null,
  base_sha: "base000",
  pr_url: null,
  note: null,
  condition: "full",
  advanced_at: "2026-09-01 08:00:00",
};

export const IMPROVE_ATTEMPT_DEFAULTS: Record<string, unknown> = {
  id: "attempt-1",
  namespace: "capsid",
  run_id: "run-1",
  change_summary: null,
  diff_ref: null,
  score_before: null,
  score_after: null,
  kept: 0,
  reason: null,
  lineage_parent: null,
  status: "pending",
  branch: null,
  head_sha: null,
  base_sha: null,
  flagged: 0,
  flag_reason: null,
  skill_id: null,
  anchors_json: null,
  secondary_json: null,
  dispatched_at: null,
  ts: "2026-09-01 08:00:00",
};

export const IMPROVE_SKILL_DEFAULTS: Record<string, unknown> = {
  id: "skill-1",
  source_namespace: "foxing",
  title: "A skill",
  body_ref: "improve/skills/skill-1.md",
  wins: 0,
  losses: 0,
  source_attempt: null,
  ts: "2026-09-01 08:00:00",
};

export interface ImproveRows {
  improve_runs: Array<Record<string, unknown>>;
  improve_attempts: Array<Record<string, unknown>>;
  improve_scores: Array<Record<string, unknown>>;
  improve_skills: Array<Record<string, unknown>>;
}

export type ImproveAnswer = { handled: false } | { handled: true; results: unknown[] };

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function isImproveStatement(sql: string): boolean {
  return /\bimprove_(runs|attempts|scores|skills)\b/i.test(sql);
}

// The column list from `INSERT INTO t (a, b, c) VALUES (?1, ?2, ?3)`, paired with
// the bound values by POSITION, resolved from the ?N markers rather than assumed
// to be 1..n in order. A literal in the VALUES list (there is one, `0`) is carried
// through as itself.
function insertRow(sql: string, params: unknown[]): Record<string, unknown> {
  const text = flat(sql);
  const cols = /INSERT INTO \w+ \(([^)]+)\)/i.exec(text)?.[1];
  const vals = /VALUES \(([^)]+)\)/i.exec(text)?.[1];
  if (!cols || !vals) throw new Error(`improve fake: could not parse the INSERT column list from: ${text}`);
  const names = cols.split(",").map((c) => c.trim());
  const values = vals.split(",").map((v) => v.trim());
  if (names.length !== values.length) {
    throw new Error(`improve fake: ${names.length} columns against ${values.length} values in: ${text}`);
  }
  const row: Record<string, unknown> = {};
  names.forEach((name, i) => {
    const value = values[i];
    const marker = /^\?(\d+)$/.exec(value);
    if (marker) row[name] = params[Number(marker[1]) - 1];
    else if (/^'.*'$/.test(value)) row[name] = value.slice(1, -1);
    else if (value === "datetime('now')") row[name] = "2026-09-01 08:00:00";
    else row[name] = Number(value);
  });
  return row;
}

// `SET a = ?1, b = datetime('now'), c = c + 1` into a patch. Handles the three
// forms the code actually emits and refuses anything else, so a fourth form is a
// failure rather than a silently ignored assignment.
function setPatch(sql: string, params: unknown[], current: Record<string, unknown>): Record<string, unknown> {
  const clause = /SET (.+?)(?: WHERE | RETURNING |$)/i.exec(flat(sql))?.[1];
  if (!clause) throw new Error(`improve fake: could not parse a SET clause from: ${flat(sql)}`);
  const patch: Record<string, unknown> = {};
  for (const assignment of clause.split(/,\s*(?=[a-z_]+\s*=)/i)) {
    const [rawCol, rawVal] = assignment.split("=").map((x) => x.trim());
    const marker = /^\?(\d+)$/.exec(rawVal);
    if (marker) patch[rawCol] = params[Number(marker[1]) - 1];
    else if (rawVal === "datetime('now')") patch[rawCol] = "2026-09-01 08:05:00";
    else if (/^'.*'$/.test(rawVal)) patch[rawCol] = rawVal.slice(1, -1);
    else if (new RegExp(`^${rawCol} \\+ 1$`).test(rawVal)) patch[rawCol] = Number(current[rawCol] ?? 0) + 1;
    else if (/^\d+(\.\d+)?$/.test(rawVal)) patch[rawCol] = Number(rawVal);
    else throw new Error(`improve fake: unmodelled assignment '${assignment}' in: ${flat(sql)}`);
  }
  return patch;
}

// The trailing `WHERE id = ?n AND status = ?m` of the guarded run update. Read
// from the END of the bind list rather than by position, because advanceRun
// appends the two predicate binds after however many the patch produced.
function guardedWhere(sql: string, params: unknown[]): { id: unknown; status: unknown } | null {
  const text = flat(sql);
  const m = /WHERE id = \?(\d+) AND status = \?(\d+)/i.exec(text);
  if (!m) return null;
  return { id: params[Number(m[1]) - 1], status: params[Number(m[2]) - 1] };
}

export function improveExec(sql: string, params: unknown[], rows: ImproveRows): ImproveAnswer {
  const text = flat(sql);
  if (!isImproveStatement(text)) return { handled: false };

  // THE BACKUP DUMP, which reads every table with a bare `SELECT * FROM <table>`.
  // Handled first because it matches no WHERE clause and would otherwise fall
  // through to the per-table readers and be mistaken for a filtered read.
  const dump = /^SELECT \* FROM (improve_\w+)$/i.exec(text);
  if (dump) {
    const table = dump[1] as keyof ImproveRows;
    if (!(table in rows)) throw new Error(`improve fake: the dump named an unknown table '${table}'`);
    return { handled: true, results: rows[table] };
  }

  // ---- runs -----------------------------------------------------------------

  if (/^INSERT INTO improve_runs/i.test(text)) {
    const row = { ...IMPROVE_RUN_DEFAULTS, ...insertRow(text, params) };
    // The partial unique index: one active run per namespace.
    const clash = rows.improve_runs.some(
      (r) => r.namespace === row.namespace && r.status !== "done" && r.status !== "paused"
    );
    if (clash) throw new Error("UNIQUE constraint failed: improve_runs.namespace (improve_runs_one_active)");
    rows.improve_runs.push(row);
    return { handled: true, results: [] };
  }

  if (/^UPDATE improve_runs/i.test(text)) {
    const where = guardedWhere(text, params);
    if (!where) throw new Error(`improve fake: an unguarded UPDATE on improve_runs: ${text}`);
    const row = rows.improve_runs.find((r) => r.id === where.id && r.status === where.status);
    if (!row) return { handled: true, results: [] };
    Object.assign(row, setPatch(text, params, row));
    return { handled: true, results: [{ id: row.id }] };
  }

  if (/^SELECT COUNT\(\*\) AS runs/i.test(text)) {
    const ns = params[0];
    const mine = rows.improve_runs.filter((r) => r.namespace === ns);
    const sum = (key: string) => mine.reduce((n, r) => n + Number(r[key] ?? 0), 0);
    return {
      handled: true,
      results: [
        {
          runs: mine.length,
          attempts: sum("attempts"),
          kept: sum("kept"),
          reverts: sum("reverts"),
          cost_usd: sum("cost_usd"),
          ci_minutes: sum("ci_minutes"),
        },
      ],
    };
  }

  // The meta-loop aggregate. Grouped by namespace over every run, with `flagged`
  // counted from the attempts table. The date predicate is not modelled: fixtures
  // are small and every row in one is deliberately in scope.
  if (/FROM improve_runs r/i.test(text) && /GROUP BY r\.namespace/i.test(text)) {
    const byNs = new Map<string, Record<string, number>>();
    for (const r of rows.improve_runs) {
      const ns = String(r.namespace);
      const acc = byNs.get(ns) ?? { runs: 0, attempts: 0, kept: 0, reverts: 0, cost_usd: 0, flagged: 0 };
      acc.runs += 1;
      acc.attempts += Number(r.attempts ?? 0);
      acc.kept += Number(r.kept ?? 0);
      acc.reverts += Number(r.reverts ?? 0);
      acc.cost_usd += Number(r.cost_usd ?? 0);
      byNs.set(ns, acc);
    }
    for (const [ns, acc] of byNs) {
      acc.flagged = rows.improve_attempts.filter((a) => a.namespace === ns && Number(a.flagged) === 1).length;
    }
    return {
      handled: true,
      results: [...byNs.entries()].map(([namespace, acc]) => ({ namespace, ...acc })).sort((a, b) => a.namespace.localeCompare(b.namespace)),
    };
  }

  if (/FROM improve_runs/i.test(text)) {
    let out = [...rows.improve_runs];
    if (/WHERE id = \?1/i.test(text)) out = out.filter((r) => r.id === params[0]);
    else {
      if (/namespace = \?1/i.test(text)) out = out.filter((r) => r.namespace === params[0]);
      if (/status NOT IN \('done', 'paused'\)/i.test(text)) out = out.filter((r) => r.status !== "done" && r.status !== "paused");
    }
    if (/ORDER BY started DESC/i.test(text)) out.sort((a, b) => String(b.started).localeCompare(String(a.started)));
    if (/ORDER BY advanced_at ASC/i.test(text)) out.sort((a, b) => String(a.advanced_at).localeCompare(String(b.advanced_at)));
    const literal = /LIMIT (\d+)/i.exec(text);
    const bound = /LIMIT \?(\d+)/i.exec(text);
    const limit = literal ? Number(literal[1]) : bound ? Number(params[Number(bound[1]) - 1]) : out.length;
    return { handled: true, results: out.slice(0, limit) };
  }

  // ---- skills ---------------------------------------------------------------
  //
  // MATCHED BEFORE THE ATTEMPTS READERS, deliberately. The candidate query carries
  // a `NOT EXISTS (SELECT 1 FROM improve_attempts ...)` subquery, so an attempts
  // branch placed first would claim it and answer with the wrong table.
  if (/FROM improve_skills s/i.test(text)) {
    const ns = params[0];
    const out = rows.improve_skills.filter(
      (s) =>
        s.source_namespace !== ns &&
        !rows.improve_attempts.some((a) => a.skill_id === s.id && a.namespace === ns)
    );
    out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return { handled: true, results: out.slice(0, 200) };
  }


  // ---- attempts -------------------------------------------------------------

  if (/^INSERT INTO improve_attempts/i.test(text)) {
    rows.improve_attempts.push({ ...IMPROVE_ATTEMPT_DEFAULTS, ...insertRow(text, params) });
    return { handled: true, results: [] };
  }

  if (/^UPDATE improve_attempts/i.test(text)) {
    const idMarker = /WHERE id = \?(\d+)/i.exec(text);
    if (!idMarker) throw new Error(`improve fake: an UPDATE on improve_attempts with no id predicate: ${text}`);
    const id = params[Number(idMarker[1]) - 1];
    const statusGuard = /AND status = '([^']+)'/i.exec(text)?.[1];
    const row = rows.improve_attempts.find((a) => a.id === id && (!statusGuard || a.status === statusGuard));
    if (!row) return { handled: true, results: [] };
    Object.assign(row, setPatch(text, params, row));
    return { handled: true, results: [{ id: row.id }] };
  }

  if (/FROM improve_attempts/i.test(text)) {
    let out = [...rows.improve_attempts];
    if (/WHERE id = \?1/i.test(text)) out = out.filter((a) => a.id === params[0]);
    else if (/WHERE run_id = \?1/i.test(text)) out = out.filter((a) => a.run_id === params[0]);
    else if (/WHERE namespace = \?1/i.test(text)) out = out.filter((a) => a.namespace === params[0]);
    if (/ORDER BY ts ASC/i.test(text)) out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (/ORDER BY ts DESC/i.test(text)) out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const bound = /LIMIT \?(\d+)/i.exec(text);
    const limit = bound ? Number(params[Number(bound[1]) - 1]) : out.length;
    return { handled: true, results: out.slice(0, limit) };
  }

  // ---- scores ---------------------------------------------------------------

  if (/^INSERT INTO improve_scores/i.test(text)) {
    rows.improve_scores.push(insertRow(text, params));
    return { handled: true, results: [] };
  }

  if (/FROM improve_scores/i.test(text)) {
    const runId = params[0];
    const wantsBaseline = /attempt_id IS NULL/i.test(text);
    const out = rows.improve_scores.filter(
      (s) => s.run_id === runId && (wantsBaseline ? s.attempt_id === null || s.attempt_id === undefined : s.attempt_id === params[1])
    );
    return { handled: true, results: out.map((s) => ({ metric: s.metric, value: s.value })) };
  }

  // ---- skills ---------------------------------------------------------------

  if (/^INSERT INTO improve_skills/i.test(text)) {
    const row = { ...IMPROVE_SKILL_DEFAULTS, ...insertRow(text, params) };
    const existing = rows.improve_skills.find((k) => k.id === row.id);
    if (existing) Object.assign(existing, { title: row.title, body_ref: row.body_ref });
    else rows.improve_skills.push(row);
    return { handled: true, results: [] };
  }

  if (/^UPDATE improve_skills/i.test(text)) {
    const row = rows.improve_skills.find((k) => k.id === params[0]);
    if (!row) return { handled: true, results: [] };
    Object.assign(row, setPatch(text, params, row));
    return { handled: true, results: [{ id: row.id }] };
  }

  throw new Error(
    `improve fake: unmodelled statement. Model it or fix the query; answering it with an empty ` +
      `result would make whatever asserts on it vacuously true.\n  ${text}`
  );
}
