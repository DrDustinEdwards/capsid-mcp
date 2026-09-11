// RECENT ACTIVITY: the last rows of audit_log, across every namespace.
//
// The audit table is the only place that answers "what happened here lately", and
// until now the only way to read it was raw SQL. This is a bounded, filtered read of
// it for the console.
//
// THE FILTER IS UNTRUSTED INPUT. Both values come off a query string a browser sends,
// so both are BOUND parameters and the statement is a static string. The test asserts
// the statement's shape as well as its results, because a value that later becomes a
// template literal passes every results-only test ever written.

export const ACTIVITY_LIMIT = 50;

export interface ActivityFilter {
  namespace: string | null;
  actor: string | null;
}

export interface ActivityRow {
  at: string;
  actor: string | null;
  action: string | null;
  namespace: string | null;
  path: string | null;
}

function param(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  // An empty value is NO filter, not a filter on the empty string. A form that
  // submits its own blank input would otherwise return nothing and look broken.
  return trimmed.length ? trimmed : null;
}

export function activityFilterFrom(url: URL): ActivityFilter {
  return { namespace: param(url, "namespace"), actor: param(url, "actor") };
}

export async function loadActivity(db: D1Database, filter: ActivityFilter): Promise<ActivityRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.namespace) {
    binds.push(filter.namespace);
    where.push(`namespace = ?${binds.length}`);
  }
  if (filter.actor) {
    binds.push(filter.actor);
    where.push(`actor = ?${binds.length}`);
  }
  binds.push(ACTIVITY_LIMIT);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // ORDER BY id DESC rather than by `at`: the column is a text timestamp written by
  // two different producers (an ISO string from this code, datetime('now') from the
  // table default), and the autoincrement id is the one thing that orders them the
  // way they actually happened.
  const { results } = await db
    .prepare(`SELECT at, actor, action, namespace, path FROM audit_log ${clause} ORDER BY id DESC LIMIT ?${binds.length}`)
    .bind(...binds)
    .all<ActivityRow>();
  return results ?? [];
}
