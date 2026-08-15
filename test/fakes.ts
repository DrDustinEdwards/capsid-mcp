// ONE SET OF FAKES (quality audit 6.2 and 6.1).
//
// Before this there were three fakeKv implementations, two withFetch copies and
// two D1 dialects, each grown for the test in front of it and each capable of
// different things. Only one KV could list, only one could inject a failure, only
// one parsed the "json" get type; a test needing list PLUS failure injection had
// nowhere to start, and the answer had always been to write a fourth. The capability
// matrix, before the merge, was:
//
//   KV            get  json  put  ttl  delete  list  seed  token-seed  fail  corrupt
//   backup         y    n     y    y     y      n     y       n         n      n
//   oauth-flow     y    n     y    y     n      n     y       n         y      y
//   repo-tools     y    y     y    n     y      y     n       y         n      n
//
// Everything in that matrix survives here, plus two capabilities no fake had and
// the code needs: cursor pagination on both KV and R2 list, because listAllKeys in
// backup.ts and invalidateRepoReads in github.ts are both cursor loops whose second
// page no test had ever reached.
//
// THE D1 FAKE IS ROW-BACKED (quality audit 6.1), and that is the change that
// matters. The old one answered on SQL SHAPE alone and ignored the bound params, so
// `WHERE id = ?1` returned version 42 whatever id was asked for, and `SELECT 1 AS ok
// FROM documents` answered ok for a row that did not exist. A fake that cannot
// disagree with the handler cannot test it: every lookup assertion was really
// asserting that the handler had issued SOME statement. Now the rows are real and
// the WHERE clauses are resolved against the bound values, so asking for the wrong
// path or the wrong version id gets nothing, exactly as D1 would answer.

// ---- KV ---------------------------------------------------------------------

export interface FakeKvOptions {
  seed?: Record<string, string>;
  // Answer any gh:token: read with a canned token so a test that is not about
  // token minting does not have to mint one. From the repo-tools fake.
  seedToken?: boolean;
  // Failure injection. From the oauth-flow fake, which is the only reason the
  // rate limiter's fail-open paths are testable.
  failGet?: boolean;
  failPut?: boolean;
  failList?: boolean;
  // Return a value that is not what the caller expects, for the corrupt-counter
  // path. From the oauth-flow fake.
  corrupt?: string;
  // Keys returned per list() page. Default is everything in one page, which is
  // what every existing test assumes; set it to force the cursor loop.
  pageSize?: number;
}

export interface FakeKv {
  store: Map<string, string>;
  puts: Array<{ key: string; value: string; ttl?: number }>;
  deleted: string[];
  keysUnder: (prefix: string) => string[];
  kv: KVNamespace;
}

export function fakeKv(opts: FakeKvOptions = {}): FakeKv {
  const { seedToken = false, pageSize } = opts;
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const deleted: string[] = [];
  const kv = {
    get: async (key: string, type?: string) => {
      if (opts.failGet) throw new Error("KV get exploded");
      if (opts.corrupt !== undefined) return opts.corrupt;
      const raw = store.get(key) ?? (seedToken && key.startsWith("gh:token:") ? "test-token" : undefined);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string, o?: { expirationTtl?: number }) => {
      if (opts.failPut) throw new Error("KV put exploded");
      puts.push({ key, value, ttl: o?.expirationTtl });
      store.set(key, value);
    },
    delete: async (key: string) => {
      deleted.push(key);
      store.delete(key);
    },
    list: async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
      if (opts.failList) throw new Error("KV list exploded");
      const all = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const size = pageSize ?? all.length;
      const page = all.slice(from, from + Math.max(size, 1));
      const next = from + page.length;
      const complete = next >= all.length;
      return complete
        ? { keys: page.map((name) => ({ name })), list_complete: true as const }
        : { keys: page.map((name) => ({ name })), list_complete: false as const, cursor: String(next) };
    },
  } as unknown as KVNamespace;
  return { store, puts, deleted, keysUnder: (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)), kv };
}

// ---- R2 ---------------------------------------------------------------------

export interface FakeR2Options {
  // Objects per list() page. Default is one page, which is what the existing
  // backup tests assume; set it to force listAllKeys through its cursor loop.
  pageSize?: number;
}

export interface FakeR2 {
  objects: Map<string, string>;
  // One entry per delete CALL, holding the keys that call removed. Kept as an
  // array of arrays because "how many delete calls" and "which keys" are
  // different questions and the backup tests ask both.
  deleted: string[][];
  bucket: R2Bucket;
}

export function fakeR2(seed: Record<string, string> = {}, opts: FakeR2Options = {}): FakeR2 {
  const objects = new Map<string, string>(Object.entries(seed));
  const deleted: string[][] = [];
  const bucket = {
    put: async (key: string, value: string) => {
      objects.set(key, value);
      return {};
    },
    list: async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
      const all = [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const size = opts.pageSize ?? all.length;
      const page = all.slice(from, from + Math.max(size, 1));
      const next = from + page.length;
      const truncated = next < all.length;
      return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(next) } : {}) };
    },
    delete: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      deleted.push(list);
      for (const key of list) objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { objects, deleted, bucket };
}

// ---- D1 ---------------------------------------------------------------------

export interface Recorded {
  sql: string;
  params: unknown[];
  via: "batch" | "direct";
}

export interface DocRow {
  namespace: string;
  path: string;
  // Defaulted, so a fixture that only cares about namespace/path/body can say so.
  id?: number;
  title?: string | null;
  body?: string | null;
  type?: string | null;
  status?: string | null;
  tags?: string | null;
  updated_at?: string;
  created_at?: string;
}

export interface VersionRow {
  id: number;
  document_id: number;
  namespace: string;
  path: string;
  title: string | null;
  body: string | null;
  snapshot_at: string;
}

export interface FakeD1Options {
  documents?: DocRow[];
  versions?: VersionRow[];
  namespaces?: Array<{ namespace: string; repos?: string }>;
  links?: Array<Record<string, unknown>>;
  // The pinned FTS probe finds its document. False stands in for an empty or
  // damaged index, which is the case a plain row count cannot see.
  ftsHit?: boolean;
  // How many rows the FTS index matches. Defaults to 1, the existing behaviour.
  ftsRows?: number;
  // Rows the backup prune should report as due, per COUNT statement in order.
  dueCounts?: number[];
  // A CONCURRENT WRITER. Runs once, immediately after the handler's pre-read of a
  // documents row and therefore BEFORE its commit-time read and its batch. That is
  // exactly the window the write predicate exists to close.
  // `target` is the (namespace, path) the handler just pre-read, so a race can
  // land on the document actually under test rather than a hardcoded one. The
  // bind-unaware fake did not need this: it had a single global "exists" flag that
  // answered for every path at once, which is exactly the imprecision 6.1 names.
  raceAfterPreRead?: (rows: FakeD1Rows, target: { namespace: string; path: string }) => void;
  // Throw from batch() for any statement matching this, to drive the "a batch
  // failure is a clean refusal" paths. The guards throw on their own.
  failBatchMatching?: RegExp;
}

export interface FakeD1Rows {
  documents: DocRow[];
  versions: VersionRow[];
  namespaces: Array<{ namespace: string; repos?: string }>;
  links: Array<Record<string, unknown>>;
}

export interface FakeD1 {
  rows: FakeD1Rows;
  // Statements this fake ANSWERED (reads), as opposed to `recorded`, which is what
  // it COMMITTED. Kept apart so the many "recorded is empty after a refusal"
  // assertions keep meaning what they say.
  reads: Recorded[];
  recorded: Recorded[];
  batches: string[][];
  db: D1Database;
}

// The three commit-time guards, evaluated against the ROWS rather than assumed to
// pass. Each is an INSERT ... SELECT NULL guarded by an EXISTS clause, and each
// aborts the batch with the same NOT NULL violation, which is what D1 does.
const GUARD_ERROR = "NOT NULL constraint failed: document_versions.document_id";

// Literal-and-star glob matching, written out rather than compiled to a RegExp so
// no pattern character needs escaping. Anchored at both ends, like GLOB.
function globMatch(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!value.startsWith(first) || !value.endsWith(last)) return false;
  if (value.length < first.length + last.length) return false;
  let at = first.length;
  for (const middle of parts.slice(1, -1)) {
    const found = value.indexOf(middle, at);
    if (found === -1 || found + middle.length > value.length - last.length) return false;
    at = found + middle.length;
  }
  return true;
}

function guardFires(sql: string, params: unknown[], rows: FakeD1Rows): boolean {
  const flat = sql.replace(/\s+/g, " ");
  if (!/INSERT INTO document_versions \(document_id, namespace, path\) SELECT NULL/i.test(flat)) return false;
  const [namespace, path] = params as [string, string];
  const row = rows.documents.find((d) => d.namespace === namespace && d.path === path);
  // requireBodyUnchanged: fires unless the row exists AND its body is the expected one.
  if (/AND body IS \?3/i.test(flat)) return !(row && row.body === params[2]);
  // requireMissing: fires when the row DOES exist.
  if (/WHERE EXISTS/i.test(flat)) return Boolean(row);
  // requireExists: fires when the row does not.
  return !row;
}

export function fakeD1(opts: FakeD1Options = {}): FakeD1 {
  const rows: FakeD1Rows = {
    documents: (opts.documents ?? []).map((d, i) => ({
      id: i + 1,
      title: null,
      body: null,
      type: "note",
      status: "published",
      tags: null,
      updated_at: "2020-01-01 00:00:00",
      created_at: "2020-01-01 00:00:00",
      ...d,
    })),
    versions: opts.versions ?? [],
    namespaces: opts.namespaces ?? [{ namespace: "capsid", repos: JSON.stringify([{ repo: "owner/repo", label: "primary" }]) }],
    links: opts.links ?? [],
  };
  const recorded: Recorded[] = [];
  // READS are logged SEPARATELY from writes, deliberately. `recorded` means "what
  // this handler committed", and a long line of tests assert it is EMPTY after a
  // refusal; folding reads into it would make every one of those assertions false
  // for a reason that has nothing to do with what they check. The bounded reads
  // (audit 9.2) need to prove the LIMIT reached the database, so they read this.
  const reads: Recorded[] = [];
  const batches: string[][] = [];
  let raced = false;

  // Every read resolves its WHERE clause from the BOUND PARAMS. This is the whole
  // point of the row-backed fake: the handler asking for the wrong path or the
  // wrong version id must get nothing back, the way the database would answer.
  const answerFirst = (sql: string, params: unknown[]): unknown => {
    const flat = sql.replace(/\s+/g, " ");
    if (/FROM namespaces WHERE namespace/i.test(flat)) {
      return rows.namespaces.find((n) => n.namespace === params[0]) ?? null;
    }
    if (/FROM document_versions WHERE id/i.test(flat)) {
      // id, namespace and path are ALL part of the lookup, deliberately: an id
      // alone would let a caller walk every snapshot in the store.
      const [id, namespace, path] = params as [number, string, string];
      return rows.versions.find((v) => v.id === id && v.namespace === namespace && v.path === path) ?? null;
    }
    if (/SELECT COUNT\(\*\) AS n/i.test(flat)) return { n: 0 };
    if (/FROM documents/i.test(flat)) {
      const [namespace, boundPath] = params as [string, string];
      // gather's core lookup binds only the namespace and writes path = 'core.md'
      // as a literal. Read it, or the fake answers null and gather looks like it
      // lost the one document it is built around.
      const literalPath = flat.match(/path = '([^']+)'/i);
      const path = literalPath ? literalPath[1] : boundPath;
      const row = rows.documents.find((d) => d.namespace === namespace && d.path === path) ?? null;
      const asOk = /SELECT 1 AS ok FROM documents/i.test(flat);
      // The commit-time read of updated_at is NOT the pre-read, so the racing
      // writer lands between them.
      //
      // The value returned is the one captured BEFORE the hook runs, and that
      // ordering is the entire point: the handler must go on holding the body it
      // read while the store underneath it has moved. Re-resolving after the race
      // would hand the handler the winner's body, its guard would match, and every
      // predicate test would pass for the wrong reason.
      const isPreRead = !/SELECT updated_at FROM documents/i.test(flat);
      const snapshot = asOk ? (row ? { ok: 1 } : null) : row ? { ...row } : null;
      if (isPreRead && opts.raceAfterPreRead && !raced) {
        raced = true;
        opts.raceAfterPreRead(rows, { namespace, path });
      }
      return snapshot;
    }
    return null;
  };

  const answerAll = (sql: string, params: unknown[]): unknown[] => {
    const flat = sql.replace(/\s+/g, " ");
    // The backup dump: SELECT * FROM <table>, no WHERE.
    const dump = flat.match(/^SELECT \* FROM (\w+)/i);
    if (dump) {
      const table = dump[1];
      if (table === "documents") return rows.documents;
      if (table === "document_versions") return rows.versions;
      if (table === "namespaces") return rows.namespaces;
      if (table === "document_links") return rows.links;
      return [];
    }
    if (/FROM document_links/i.test(flat)) {
      const [namespace, path] = params as [string, string];
      return rows.links.filter(
        (l) =>
          (l.from_ns === namespace && l.from_path === path) || (l.to_ns === namespace && l.to_path === path)
      );
    }
    if (/FROM documents_fts/i.test(flat)) {
      if (opts.ftsHit === false) return [];
      // One hit by default, which is what every existing caller expects. ftsRows
      // asks for more so the search tool's page bound can be driven; the LIMIT is
      // honoured from its bound param, as it is for the other multi-row reads.
      const wanted = opts.ftsRows ?? 1;
      const limit = /LIMIT \?\d+/.test(flat) && typeof params[params.length - 1] === "number"
        ? (params[params.length - 1] as number)
        : Infinity;
      return Array.from({ length: Math.min(wanted, limit) }, (_, i) => ({
        path: i === 0 ? "conventions.md" : `hit-${i}.md`,
      }));
    }
    // MULTI-ROW DOCUMENT SELECTS: list, find, the resource listing and gather's
    // two section queries. Added for the bounded-read work (audit 9.2), which
    // could not be tested without it: every one of these fell through to the
    // single-row lookup below, which reads params[0] and params[1] as a
    // (namespace, path) pair, so `list` asked for a document whose path was its
    // `type` filter and the fake answered [] to everything. A bound that is only
    // ever exercised against an empty result set is not tested at all.
    //
    // The LIMIT is honoured from its BOUND PARAM rather than ignored, so a handler
    // that stops asking the database for a bounded page fails here instead of
    // being silently rescued by the fake returning everything anyway.
    if (/FROM documents/i.test(flat) && /ORDER BY/i.test(flat) && !/SELECT updated_at/i.test(flat)) {
      const limit = /LIMIT \?\d+/.test(flat) && typeof params[params.length - 1] === "number"
        ? (params[params.length - 1] as number)
        : Infinity;
      let out = [...rows.documents];
      if (/path GLOB \?1/i.test(flat)) {
        // SQLite GLOB. Only `*` is implemented, which is the only wildcard these
        // tools are used with; a pattern using any other GLOB metacharacter would
        // match literally here and the test asserting it would fail loudly rather
        // than quietly passing on a wrong answer.
        const [glob, ns] = params as [string, string | null];
        out = out.filter((d) => globMatch(glob, d.path) && (ns == null || d.namespace === ns));
      } else if (/\(\?1 IS NULL OR namespace = \?1\)/i.test(flat)) {
        const [ns, type, status] = params as [string | null, string | null, string | null];
        out = out.filter(
          (d) =>
            (ns == null || d.namespace === ns) &&
            (type == null || d.type === type) &&
            (status == null || d.status === status)
        );
      } else if (/namespace > \?1 OR \(namespace = \?1 AND path > \?2\)/i.test(flat)) {
        // resources/list keyset cursor: strictly after the (namespace, path)
        // tuple named by the cursor. Implemented as a TUPLE compare here too,
        // because a fake that compared a concatenated key would hide exactly the
        // boundary bug the real query is written this way to avoid.
        const [ns, path] = params as [string, string];
        if (ns !== "" || path !== "") {
          out = out.filter((d) => d.namespace > ns || (d.namespace === ns && d.path > path));
        }
      } else if (/namespace = \?1/i.test(flat)) {
        const ns = params[0] as string;
        out = out.filter((d) => d.namespace === ns);
      }
      // gather's rules query pins its namespace and its paths as LITERALS rather
      // than binding them. Resolved here too, or the fake hands gather every
      // seeded document as "the rules" and the size arithmetic under test is
      // measuring the wrong rows.
      const literalNs = flat.match(/namespace = '([^']+)'/i);
      if (literalNs) out = out.filter((d) => d.namespace === literalNs[1]);
      const pathIn = flat.match(/path IN \(([^)]+)\)/i);
      if (pathIn) {
        const wanted = pathIn[1].split(",").map((t) => t.trim().replace(/'/g, ""));
        out = out.filter((d) => wanted.includes(d.path));
      }
      const types = flat.match(/type IN \(([^)]+)\)/i);
      if (types) {
        const wanted = types[1].split(",").map((t) => t.trim().replace(/'/g, ""));
        out = out.filter((d) => wanted.includes(String(d.type)));
      }
      if (/path NOT LIKE 'archive\/%'/i.test(flat)) out = out.filter((d) => !d.path.startsWith("archive/"));
      if (/ORDER BY created_at/i.test(flat)) out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      else out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.path.localeCompare(b.path));
      return out.slice(0, limit);
    }
    if (/FROM document_versions WHERE namespace/i.test(flat)) {
      const [namespace, path] = params as [string, string];
      return rows.versions.filter((v) => v.namespace === namespace && v.path === path);
    }
    const single = answerFirst(sql, params);
    return single ? [single] : [];
  };

  let countCall = 0;
  const stmt = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...bound: unknown[]) => stmt(sql, bound),
    first: async () => {
      reads.push({ sql, params, via: "direct" });
      if (/FROM documents_fts/i.test(sql)) {
        return opts.ftsHit === false ? null : { path: "conventions.md" };
      }
      return answerFirst(sql, params);
    },
    all: async () => {
      reads.push({ sql, params, via: "direct" });
      return { results: answerAll(sql, params), meta: { changes: 0 } };
    },
    run: async () => {
      recorded.push({ sql, params, via: "direct" });
      return { meta: { changes: 1 } };
    },
  });

  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
      batches.push(statements.map((s) => s.sql.replace(/\s+/g, " ").trim()));
      for (const s of statements) {
        if (opts.failBatchMatching?.test(s.sql)) throw new Error("D1_ERROR: database is locked");
        // A guard that fires aborts the transaction, so nothing this batch would
        // have written is recorded. That is the property under test.
        if (guardFires(s.sql, s.params, rows)) throw new Error(GUARD_ERROR);
      }
      // Only once every statement has passed does anything land, which is what a
      // transaction means.
      for (const s of statements) recorded.push({ sql: s.sql, params: s.params, via: "batch" });
      return statements.map((s) => ({
        // Inflated on purpose: FTS5 triggers inflate meta.changes on this schema,
        // which is why the code counts with a SELECT instead of reading it.
        meta: { changes: 999 },
        results: /SELECT COUNT/i.test(s.sql) ? [{ n: opts.dueCounts?.[countCall++] ?? 0 }] : [],
      }));
    },
  } as unknown as D1Database;

  return { rows, recorded, reads, batches, db };
}

// ---- HTTP -------------------------------------------------------------------

export type RouteSpec = { status?: number; body?: unknown; text?: string };
export type Route = RouteSpec | ((requestBody: unknown) => RouteSpec);

export interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

// Route GitHub calls by "METHOD pathname" (query ignored) to a canned response,
// and record every call. A route may be a function, so a test can serve a body
// that CHANGES after a write, which is the only way to tell a fresh read from a
// cached one. The recorded calls are how a cap is proven by the request that was
// NOT made.
export async function withFetch(
  routes: Record<string, Route>,
  fn: (calls: FetchCall[]) => Promise<void> | void
): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: parsed.pathname, body });
    const route = routes[`${method} ${parsed.pathname}`];
    if (!route) return new Response(`no route for ${method} ${parsed.pathname}`, { status: 500 });
    const spec = typeof route === "function" ? route(body) : route;
    const payload = spec.text !== undefined ? spec.text : spec.body === undefined ? "" : JSON.stringify(spec.body);
    return new Response(payload, { status: spec.status ?? 200 });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// ---- Env --------------------------------------------------------------------

// The Env stub. Still `as never` at the boundary: the real Env has a dozen
// bindings and a test that needs two should not have to fake ten. What changed is
// that src/env.ts now owns the type, so this cast is against a leaf rather than
// against the whole MCP server module.
export function fakeEnv(parts: Record<string, unknown>): never {
  return parts as never;
}
