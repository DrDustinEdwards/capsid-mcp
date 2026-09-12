// The improve tables, taught to the one D1 fake.
//
// A SEPARATE MODULE, NOT A SECOND FAKE. test/fakes.ts still owns the single
// fakeD1(); this file is the dialect it delegates to when a statement names an
// improve_* table. The rule from quality audit 6.2 is that there is one fake per binding,
// not that one file holds every SQL shape, and folding four more tables into the document
// dialect would have made this file too large to read.
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
  // The replay cache (migrations/0004). Row-backed like the rest, so the PRIMARY
  // KEY behaviour the code now relies on is actually modelled: a second claim of
  // the same (scope, jti) returns no row, and the fake can therefore DISAGREE
  // with a handler that assumed it would.
  improve_jti: Array<Record<string, unknown>>;
  // The skill lifecycle's evidence (migrations 0012 and 0013). Row-backed like the
  // rest so a summary assertion can actually disagree with the handler.
  skill_evaluations: Array<Record<string, unknown>>;
  skill_edits: Array<Record<string, unknown>>;
  skill_failures: Array<Record<string, unknown>>;
  // THE RECOMMEND BRANCH NEEDS THE DOCUMENT BODIES, because the query it models joins
  // documents_fts and the match is against a skill's prose. Modelling the match
  // against trigger_condition instead would be a fake that tests something other than
  // the query. Optional: only that one branch reads it, and fakeD1 already passes its
  // own rows object, which carries documents.
  documents?: ReadonlyArray<{ namespace: string; path: string; body?: string | null }>;
}

export type ImproveAnswer = { handled: false } | { handled: true; results: unknown[] };

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

export function isImproveStatement(sql: string): boolean {
  return /\b(improve_(runs|attempts|scores|skills|jti)|skill_evaluations|skill_edits|skill_failures)\b/i.test(sql);
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
    // documents is excluded: this branch only matches improve_* tables, and including
    // it would widen the result type to the read-only shape the recommend branch uses.
    const table = dump[1] as Exclude<keyof ImproveRows, "documents">;
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

  // The budget month-spend aggregate: whole-table sums bounded by started date.
  if (/^SELECT COALESCE\(SUM\(cost_usd\), 0\) AS cost_usd/i.test(text) && /started >= \?1/i.test(text)) {
    const from = String(params[0]);
    const inMonth = rows.improve_runs.filter((r) => String(r.started) >= from);
    const sum = (key: string) => inMonth.reduce((n, r) => n + Number(r[key] ?? 0), 0);
    return { handled: true, results: [{ cost_usd: sum("cost_usd"), ci_minutes: sum("ci_minutes") }] };
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

  // ---- the replay cache -----------------------------------------------------

  // INSERT ... ON CONFLICT DO NOTHING RETURNING. The DATABASE decides who claimed the
  // nonce, so the fake models the uniqueness rather than the SQL: a row already present
  // returns nothing.
  if (/^INSERT INTO improve_jti/i.test(text)) {
    const [scope, jti] = params;
    const already = rows.improve_jti.some((r) => r.scope === scope && r.jti === jti);
    if (already) return { handled: true, results: [] };
    rows.improve_jti.push({ scope, jti, seen_at: "2026-09-01 08:00:00" });
    return { handled: true, results: [{ jti }] };
  }

  if (/^DELETE FROM improve_jti/i.test(text)) {
    rows.improve_jti.length = 0;
    return { handled: true, results: [] };
  }

  // THE WHOLE-TABLE READ the nightly dump makes, matched before the filtered ones so
  // a `SELECT *` is not answered by a branch that expects bound parameters.
  if (/^SELECT \* FROM skill_(evaluations|edits|failures)/i.test(text)) {
    const table = /FROM (skill_\w+)/i.exec(text)?.[1] as "skill_evaluations" | "skill_edits" | "skill_failures";
    return { handled: true, results: rows[table] };
  }


  // THE RECOMMEND QUERY, matched before the generic `FROM improve_skills s` reader
  // below for the reason that one already documents: a less specific branch placed
  // first claims this and answers from the wrong table.
  if (/JOIN documents_fts f/i.test(text)) {
    const like = String(params[1] ?? "");
    const ns = like.replace(/^%"|"%$/g, "");
    const terms = String(params[0] ?? "").toLowerCase().split(" or ").filter(Boolean);
    const limit = Number(params[2] ?? 3);
    const out = rows.improve_skills.filter((s) => {
      if (!["candidate", "live"].includes(String(s.status))) return false;
      if (s.trigger_condition === null || s.trigger_condition === undefined) return false;
      if (s.namespaces !== null && s.namespaces !== undefined && !String(s.namespaces).includes('"' + ns + '"')) return false;
      // The MATCH, modelled: the skill's document body must contain one of the terms.
      const doc = (rows.documents ?? []).find((d) => d.path === s.body_ref && d.namespace === "capsid");
      const body = String(doc?.body ?? "").toLowerCase();
      return terms.some((t) => body.includes(t));
    });
    return { handled: true, results: out.slice(0, limit) };
  }

  // Every candidate and live skill, for the transition pass.
  if (/^SELECT id, status, version FROM improve_skills/i.test(text)) {
    const out = rows.improve_skills.filter((s) => ["candidate", "live"].includes(String(s.status)));
    return { handled: true, results: out };
  }


  // The optimizer's negative feedback: refused proposals only, newest first.
  if (/FROM skill_edits/i.test(text)) {
    const skill = params[0];
    // THE FILTER IS READ FROM THE SQL, not assumed. A fake that applied `accepted = 0`
    // whatever the query said could not disagree with a handler that stopped asking
    // for it, and a plant removing that clause would leave this green.
    const onlyRejected = /accepted = 0/i.test(text);
    const mine = rows.skill_edits.filter((e) => e.skill === skill && (!onlyRejected || Number(e.accepted) === 0));
    mine.sort((a, b) => String(b.evaluated_at).localeCompare(String(a.evaluated_at)));
    return { handled: true, results: mine.slice(0, Number(params[1] ?? 5)) };
  }

  // The merge scan: live skills with a trigger, joined to their prose. Matched before
  // the generic `FROM improve_skills s` reader for the reason that one documents.
  if (/LEFT JOIN documents d/i.test(text)) {
    // Both filters read from the SQL for the same reason as above: this branch must be
    // able to disagree with a handler that dropped one of them.
    const onlyLive = /s\.status = 'live'/i.test(text);
    const needsTrigger = /s\.trigger_condition IS NOT NULL/i.test(text);
    const out = rows.improve_skills
      .filter(
        (s) =>
          (!onlyLive || String(s.status) === "live") &&
          (!needsTrigger || (s.trigger_condition !== null && s.trigger_condition !== undefined))
      )
      .map((s) => ({
        id: s.id,
        status: s.status,
        trigger_condition: s.trigger_condition,
        body: (rows.documents ?? []).find((d) => d.path === s.body_ref && d.namespace === "capsid")?.body ?? null,
      }));
    return { handled: true, results: out };
  }


  // ---- the skill records summary (migrations 0012, 0013) --------------------
  //
  // Modelled against the rows rather than answered empty, on this fake's own rule:
  // an empty answer would make every assertion about the summary vacuously true.
  if (/SELECT status, COUNT\(\*\) AS n FROM improve_skills/i.test(text)) {
    const like = String(params[0] ?? "");
    const ns = like.replace(/^%"|"%$/g, "");
    const counts = new Map<string, number>();
    for (const skill of rows.improve_skills) {
      const scoped =
        skill.namespaces === null || skill.namespaces === undefined || String(skill.namespaces).includes('"' + ns + '"');
      if (!scoped) continue;
      const status = String(skill.status ?? "candidate");
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return { handled: true, results: [...counts].map(([status, n]) => ({ status, n })) };
  }

  if (/FROM skill_evaluations/i.test(text) && /MAX\(evaluated_at\)/i.test(text)) {
    const ns = params[0];
    const mine = rows.skill_evaluations.filter((e) => e.namespace === ns);
    const last = mine.map((e) => String(e.evaluated_at)).sort().pop() ?? null;
    return { handled: true, results: [{ last }] };
  }

  if (/FROM skill_evaluations/i.test(text)) {
    const [skill, version] = params;
    const mine = rows.skill_evaluations.filter((e) => e.skill === skill && e.version === version);
    mine.sort((a, b) => String(a.evaluated_at).localeCompare(String(b.evaluated_at)));
    return { handled: true, results: mine };
  }

  if (/^INSERT INTO skill_(evaluations|edits|failures)/i.test(text)) {
    const table = /^INSERT INTO (skill_\w+)/i.exec(text)?.[1] as "skill_evaluations" | "skill_edits" | "skill_failures";
    rows[table].push(insertRow(text, params));
    return { handled: true, results: [] };
  }

  if (/FROM skill_failures/i.test(text)) {
    const skill = params[0];
    const mine = rows.skill_failures.filter((f) => f.skill === skill);
    mine.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { handled: true, results: mine.slice(0, Number(params[1] ?? 2)) };
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

// ONE SSE ATTEMPT RESPONSE. The attempt path uses the SDK's streaming helper, so a
// plain JSON body is answered with "request ended without sending any chunks", and a
// test that hands it one is exercising a non-streaming lookalike.
//
// Three files built this event stream: improve-run.test.ts and
// audit-2026-09-06-round2.test.ts held byte-identical copies (the second said so in
// a comment), and improve-caching.test.ts held a twin that differed only in the
// cache token counters it needs.
export function sseMessage(text: string, usage: Record<string, unknown> = {}): string {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 0, ...usage },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

// The shape proposeChange parses, over that stream.
export function sseChange(files: Array<{ path: string; content: string }>): string {
  return sseMessage(JSON.stringify({ summary: "s", reasoning: "r", files }));
}
