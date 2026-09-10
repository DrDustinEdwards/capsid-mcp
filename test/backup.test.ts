import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runBackup, TABLES } from "../src/backup.ts";
import { fakeD1, fakeEnv, fakeKv, fakeR2, type FakeD1Options } from "./fakes.ts";

// FTS5 derives documents_fts from documents and the sync triggers rebuild it on
// import, so the virtual table and its shadow tables are never exported.
const DERIVED = /^(documents_fts|sqlite_)/;

function tablesInMigrations(): string[] {
  const dir = join(import.meta.dirname, "..", "migrations");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    // CREATE VIRTUAL TABLE does not match, which keeps documents_fts out.
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)) {
      if (!DERIVED.test(m[1])) names.add(m[1]);
    }
  }
  return [...names].sort();
}

test("the migrations parse to a non-empty table list", () => {
  // Guards the regex itself: a parser that silently matches nothing would make
  // every assertion below vacuously pass.
  assert.ok(tablesInMigrations().length >= 5);
});

test("every table the migrations create is backed up", () => {
  const missing = tablesInMigrations().filter((t) => !TABLES.includes(t as (typeof TABLES)[number]));
  assert.deepEqual(missing, [], `migrations create tables that src/backup.ts does not export: ${missing.join(", ")}`);
});

test("every backed-up table exists in the migrations", () => {
  const inMigrations = tablesInMigrations();
  const unknown = TABLES.filter((t) => !inMigrations.includes(t));
  assert.deepEqual(unknown, [], `src/backup.ts exports tables no migration creates: ${unknown.join(", ")}`);
});

test("the FTS5 virtual table and its shadow tables are not exported", () => {
  assert.deepEqual(TABLES.filter((t) => DERIVED.test(t)), []);
});

// ---- the run itself ---------------------------------------------------------
//
// FAKES, AND WHY THEY ARE SHAPED THIS WAY (audit 2 batch B). There was no fake R2 in
// this repo, so one is added here and it is written to be capable of the thing under
// test: it holds real state and it RECORDS EVERY DELETE. A bucket that cannot express a
// delete would make "refuses to delete the mirror" pass whether or not anything was
// refused, which is the vacuous-guard shape.
//
// The fake D1 answers three shapes: SELECT * FROM <table> (the export), the pinned
// FTS probe (the preflight), and the count-then-delete batch. Its batch deliberately
// reports an INFLATED meta.changes, because that is what D1 does here (the FTS5
// triggers inflate it) and it is the number the run must NOT be reading.

// The fakes are shared now (quality audit 6.2). What used to be three local
// implementations here is one import; the capabilities this file relied on
// (recorded deletes per call, recorded puts with their ttl, an FTS probe that can
// miss, inflated meta.changes on the prune batch) all survive in the merged
// version, and it gained cursor pagination, which no fake had.

function makeEnv(dbOpts: FakeD1Options, seedR2: Record<string, string> = {}, seedKv: Record<string, string> = {}) {
  const r2 = fakeR2(seedR2);
  const kv = fakeKv({ seed: seedKv });
  const { db, batches } = fakeD1(dbOpts);
  return { env: fakeEnv({ DB: db, MEDIA: r2.bucket, APP_KV: kv.kv }), r2, kv, batches };
}

// Captures console.error so a test can assert the run was LOUD, not just that it
// returned a field.
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

const DOCS = [
  { namespace: "capsid", path: "core.md", body: "core" },
  { namespace: "capsid", path: "conventions.md", body: "conventions" },
];
const MIRROR = {
  "backups/markdown/capsid/core.md": "core",
  "backups/markdown/capsid/conventions.md": "conventions",
  "backups/markdown/capsid/deleted-yesterday.md": "gone",
};

test("a healthy run dumps one object per table, keyed by TABLES", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  // Derived from TABLES in both directions: a table added to the export without an
  // object, or an object with no table, fails here. The two underscore-prefixed
  // sidecars (the KV pins and the holdout manifests) are named explicitly rather
  // than matched by shape, so dropping one is a failure here too.
  const expected = [
    ...TABLES.map((t) => `${result.json_prefix}${t}.json`),
    `${result.json_prefix}_kv.json`,
    `${result.json_prefix}_holdout-manifests.json`,
  ].sort();
  assert.deepEqual([...result.json_keys].sort(), expected);
  assert.deepEqual([...r2.objects.keys()].filter((k) => k.startsWith(result.json_prefix)).sort(), expected);
  // Each object carries its own table's rows, not the whole database.
  const dumped = JSON.parse(r2.objects.get(`${result.json_prefix}documents.json`) as string);
  assert.equal(dumped.table, "documents");
  assert.equal(dumped.rows.length, 2);
});

test("a healthy run prunes genuinely stale markdown and keeps the current mirror", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.equal(result.prune_refused, null);
  assert.equal(result.markdown_pruned, 1);
  assert.deepEqual(r2.deleted.flat(), ["backups/markdown/capsid/deleted-yesterday.md"]);
  assert.ok(r2.objects.has("backups/markdown/capsid/core.md"));
  assert.ok(r2.objects.has("backups/markdown/capsid/conventions.md"));
});

test("an empty documents read refuses the prune, loudly, and deletes nothing", async () => {
  // The dangerous case: the SELECT SUCCEEDS and returns no rows. Every mirror object
  // is then "stale" and the old code deleted all of them in one call.
  const { env, r2 } = makeEnv({ documents: [] }, MIRROR);
  const { result, logged } = await captureErrors(() => runBackup(env));
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.equal(result.prune_refused, "documents-empty");
  assert.equal(result.preflight.documents, 0);
  assert.deepEqual(r2.deleted, [], "the refused run deleted objects");
  for (const key of Object.keys(MIRROR)) assert.ok(r2.objects.has(key), `${key} was wiped`);
  // Loud, and named, so a log search finds it without knowing the wording.
  assert.ok(logged.some((line) => line.includes("BACKUP_PREFLIGHT_REFUSED")), logged.join("\n"));
  // The dumps are still written: an export deletes nothing, and an empty dump is
  // the evidence of the day the store looked empty.
  assert.equal(result.json_keys.length, TABLES.length + 2);
  for (const key of result.json_keys) assert.ok(r2.objects.has(key));
});

test("a failing FTS probe refuses the prune even when documents has rows", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS, ftsHit: false }, MIRROR);
  const { result, logged } = await captureErrors(() => runBackup(env));
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.match(result.prune_refused ?? "", /^fts-probe-failed/);
  assert.deepEqual(r2.deleted, []);
  assert.ok(logged.some((line) => line.includes("BACKUP_PREFLIGHT_REFUSED")));
});

test("a second concurrent runner exits named and touches nothing", async () => {
  const { env, r2, kv, batches } = makeEnv({ documents: DOCS }, MIRROR, {
    "backup:lease": "2026-08-17T09:00:00.000Z",
  });
  const { result, logged } = await captureErrors(() => runBackup(env));
  assert.equal(result.ran, false);
  if (result.ran) return;

  assert.equal(result.skipped, "lease-held");
  assert.deepEqual(r2.deleted, []);
  assert.deepEqual(batches, [], "the skipped run still pruned D1");
  assert.deepEqual(kv.puts, [], "the skipped run took the lease anyway");
  // The first run's lease survives: a loser must not release a lease it never held.
  assert.equal(kv.store.get("backup:lease"), "2026-08-17T09:00:00.000Z");
  assert.ok(logged.some((line) => line.includes("BACKUP_LEASE_HELD")));
});

test("the lease carries an expiry and is released when the run ends", async () => {
  const { env, kv } = makeEnv({ documents: DOCS }, MIRROR);
  await runBackup(env);
  // A clean run puts twice: the lease (with a ttl) and backup:last-ok (without).
  const lease = kv.puts.find((p) => p.key === "backup:lease");
  assert.ok(lease, "the lease was never taken");
  // A crashed run must not wedge backups forever, so the lease cannot be eternal,
  // and KV will not accept a TTL under 60 seconds.
  assert.ok((lease.ttl ?? 0) >= 60, "lease has no usable expiry");
  assert.equal(kv.store.has("backup:lease"), false, "lease was not released");
});

test("the lease is released even when the run throws", async () => {
  const { env, kv } = makeEnv({ documents: DOCS }, MIRROR);
  (env as unknown as { MEDIA: R2Bucket }).MEDIA = {
    put: async () => {
      throw new Error("r2 exploded");
    },
  } as unknown as R2Bucket;
  await assert.rejects(() => runBackup(env), /r2 exploded/);
  // Both halves, or this passes by reading nothing: a run that never took a lease
  // also leaves no lease behind.
  assert.equal(kv.puts.length, 1, "the run never took a lease");
  assert.equal(kv.store.has("backup:lease"), false, "the lease outlived the failed run");
});

test("versions_pruned and audit_pruned come from a COUNT, not meta.changes", async () => {
  const { env, batches } = makeEnv({ documents: DOCS, dueCounts: [3, 7] }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  // The fake reports meta.changes 999 on every statement, which is what D1 does here
  // (FTS5 triggers inflate it). Reading it would show 999.
  assert.equal(result.versions_pruned, 3);
  assert.equal(result.audit_pruned, 7);
  // The count and the delete must carry the identical predicate, or the count is of
  // a different set of rows than the one that leaves. TWO batches now: the export
  // snapshot and this one. The prune batch is found by what it contains rather than
  // by position, so a third batch cannot silently retarget these assertions.
  assert.equal(batches.length, 2);
  const pruneBatch = batches.find((b) => b.some((sql) => sql.startsWith("DELETE FROM document_versions")));
  assert.ok(pruneBatch, "no batch carried the prune");
  const [countVersions, deleteVersions, countAudit, deleteAudit] = pruneBatch;
  assert.match(countVersions, /^SELECT COUNT\(\*\) AS n FROM document_versions WHERE snapshot_at < /);
  assert.equal(deleteVersions.replace(/^DELETE FROM/, "SELECT COUNT(*) AS n FROM"), countVersions);
  assert.match(countAudit, /^SELECT COUNT\(\*\) AS n FROM audit_log WHERE at < /);
  assert.equal(deleteAudit.replace(/^DELETE FROM/, "SELECT COUNT(*) AS n FROM"), countAudit);
});

test("dump retention keeps the newest runs whole, counting runs and not objects", async () => {
  // 20 aged-out runs of five objects each. If the floor counted OBJECTS it would
  // keep 14 of 100, which is under three runs; it must keep 14 RUNS.
  const seed: Record<string, string> = { ...MIRROR };
  const runIds: string[] = [];
  for (let day = 1; day <= 20; day++) {
    const id = `2020-01-${String(day).padStart(2, "0")}T00-00-00-000Z`;
    runIds.push(id);
    for (const table of TABLES) seed[`backups/json/${id}/${table}.json`] = "{}";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  // 21 runs exist once this run writes its own, the floor keeps the newest 14, and
  // the 7 left over are all past the cutoff, so they age out whole.
  assert.equal(result.json_backups_pruned, 7);
  assert.equal(result.json_backups_kept, 14);
  const deletedDumps = r2.deleted.flat().filter((k) => k.startsWith("backups/json/"));
  assert.equal(deletedDumps.length, 7 * TABLES.length);
  const survivors = runIds.filter((id) => [...r2.objects.keys()].some((k) => k.startsWith(`backups/json/${id}/`)));
  assert.deepEqual(survivors, runIds.slice(7), "a run was half-deleted or the wrong runs aged out");
  // And a surviving run keeps every one of its objects, not just some.
  for (const id of survivors) {
    for (const table of TABLES) assert.ok(r2.objects.has(`backups/json/${id}/${table}.json`));
  }
});

test("a pre-change flat dump key ages as its own single-object run", async () => {
  // Objects written before the per-table split have no slash after the prefix. They
  // must still age out rather than sit forever or drag a whole day down with them.
  const seed: Record<string, string> = { ...MIRROR };
  for (let day = 1; day <= 20; day++) {
    seed[`backups/json/2020-01-${String(day).padStart(2, "0")}T00-00-00-000Z.json`] = "{}";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.equal(result.json_backups_pruned, 7);
  assert.equal(r2.deleted.flat().filter((k) => k.startsWith("backups/json/")).length, 7);
});

test("/health and the backup preflight probe the index through one module", () => {
  // They must agree. A backup that carried its own copy of the probe would drift
  // from the one the live gate asserts, and the drift would only surface on the day
  // the store was actually broken. /health lives in health.ts since 2026-09-07.
  const src = (name: string) => readFileSync(join(import.meta.dirname, "..", "src", name), "utf8");
  for (const name of ["health.ts", "backup.ts"]) {
    assert.match(src(name), /from "\.\/store-probe"/, `${name} does not use the shared probe`);
    assert.doesNotMatch(src(name), /documents_fts MATCH/, `${name} carries its own copy of the FTS probe`);
  }
  assert.match(src("store-probe.ts"), /documents_fts MATCH/);
});

test("a clean run stamps backup:last-ok with the run timestamp", async () => {
  const { env, kv } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;
  const stamp = kv.puts.find((p) => p.key === "backup:last-ok");
  assert.ok(stamp, "a clean run did not stamp backup:last-ok");
  // The stamp is the same ISO instant the run used for its lease and dump prefix,
  // so /health's age is measured from when the backup actually ran.
  assert.match(stamp.value, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test("a preflight-refused run does NOT stamp backup:last-ok", async () => {
  // A run that would not trust its own read of the store must not report itself as
  // a fresh backup, or /health would go quiet on exactly the day it should warn.
  const { env, kv } = makeEnv({ documents: [] }, MIRROR);
  await captureErrors(() => runBackup(env));
  assert.equal(kv.puts.some((p) => p.key === "backup:last-ok"), false, "a refused run stamped itself as fresh");
});

// ---- the 1000-key delete ceiling (residual 5) --------------------------------
//
// R2's bulk delete takes at most 1000 keys per call and throws on the 1001st. All
// three of the run's deletes handed it an unbounded array, so the first day the
// mirror shed more than a thousand documents, or the day a backlog of aged dumps
// came due, the backup threw AFTER writing its dumps and BEFORE stamping
// backup:last-ok. The failure would have been loud, which is the only good part.
//
// 1001 rather than a round 1000 because the boundary is where an off-by-one lives:
// a chunker written with `<` instead of `<=` passes at exactly 1000.
const R2_DELETE_CEILING = 1000;

test("no single R2 delete call exceeds R2's 1000-key ceiling", async () => {
  const seed: Record<string, string> = {};
  for (let i = 0; i < 1001; i++) {
    seed[`backups/markdown/capsid/stale-${String(i).padStart(5, "0")}.md`] = "gone";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const oversized = r2.deleted.filter((call) => call.length > R2_DELETE_CEILING);
  assert.deepEqual(
    oversized.map((call) => call.length),
    [],
    `an R2 delete call carried more than ${R2_DELETE_CEILING} keys, which R2 refuses`
  );
  // NOT VACUOUS: the chunking must still delete everything it was asked to. A
  // chunker that dropped the tail would satisfy the assertion above.
  assert.equal(result.markdown_pruned, 1001);
  const leftover = [...r2.objects.keys()].filter((k) => k.includes("/stale-"));
  assert.deepEqual(leftover, [], "chunking lost keys: stale mirror objects survived the prune");
});

test("the dump prune chunks too, not just the mirror", async () => {
  // 22 aged runs x 10 tables is 220 keys, which is under the ceiling, so the dump
  // prune is exercised for CHUNK SHAPE rather than for overflow: every call it
  // makes must come from the same chunker. The guard is that the run's delete
  // calls are all within the ceiling AND that the aged dumps are all gone.
  const seed: Record<string, string> = { ...MIRROR };
  for (let day = 1; day <= 22; day++) {
    const id = `2020-01-${String(day).padStart(2, "0")}T00-00-00-000Z`;
    for (const table of TABLES) seed[`backups/json/${id}/${table}.json`] = "{}";
  }
  for (let i = 0; i < 1200; i++) {
    seed[`reports/csp/2020-01-01/${String(i).padStart(5, "0")}.json`] = "{}";
  }
  const { env, r2 } = makeEnv({ documents: DOCS }, seed);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  assert.deepEqual(r2.deleted.filter((c) => c.length > R2_DELETE_CEILING).map((c) => c.length), []);
  assert.equal(result.reports_pruned, 1200);
  assert.deepEqual([...r2.objects.keys()].filter((k) => k.startsWith("reports/csp/")), []);
});

// ---- one consistent snapshot (residual 4) -----------------------------------
//
// The export used to be a `for` loop of `SELECT * FROM <table>`, each its own
// round trip. Ten reads at ten different instants is ten snapshots, not one: a
// write landing between the documents read and the document_versions read puts a
// version row in the dump whose document is not in it, and NOTHING could see that
// afterwards. D1's batch is one transaction, so the ten reads now agree with each
// other by construction and `exported_at` is finally true rather than decorative.

test("every table is read in ONE D1 batch, not ten round trips", async () => {
  const { env, batches } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);

  const exportBatch = batches.find((b) => b.includes("SELECT * FROM documents"));
  assert.ok(exportBatch, "no batch carried the export; the tables are still read one at a time");
  assert.deepEqual(
    exportBatch,
    TABLES.map((t) => `SELECT * FROM ${t}`),
    "the export batch is not exactly the table list, in order"
  );
});

test("the dump carries the loop's KV pins, by allowlist and never by prefix sweep", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR, {
    improve_mode: "subscription",
    "improve:budget": '{"actions_minutes_month":300,"model_usd_month":50}',
    "improve:anchor:capsid": "sha256-of-the-anchor-block",
    "improve:paused:foxing": "paused by hand",
    // A CACHED GITHUB TOKEN. It lives in the same namespace as the pins and must
    // never reach a dump: the dump leaves the account, and an installation token
    // is a credential.
    "gh:token:DrDustinEdwards": "ghs-not-a-real-token",
  });
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const raw = r2.objects.get(`${result.json_prefix}_kv.json`);
  assert.ok(raw, "the dump carries no KV pins; the loop's memory is not in the backup");
  const dumped = JSON.parse(raw as string) as { keys: Record<string, string | null> };
  assert.equal(dumped.keys.improve_mode, "subscription");
  assert.equal(dumped.keys["improve:anchor:capsid"], "sha256-of-the-anchor-block");
  assert.equal(dumped.keys["improve:paused:foxing"], "paused by hand");
  const leaked = Object.keys(dumped.keys).filter((k) => k.startsWith("gh:"));
  assert.deepEqual(leaked, [], "the KV dump swept a prefix and carried a cached credential out of the account");
});

test("the dump carries the holdout manifests, which are counts and never tests", async () => {
  const { env, r2 } = makeEnv({ documents: DOCS }, MIRROR);
  const result = await runBackup(env);
  assert.equal(result.ran, true);
  if (!result.ran) return;

  const raw = r2.objects.get(`${result.json_prefix}_holdout-manifests.json`);
  assert.ok(raw, "the dump carries no holdout manifests; the hidden suites' sizes exist in one place only");
  const dumped = JSON.parse(raw as string) as { manifests: Record<string, unknown> };
  assert.equal(dumped.manifests.capsid !== undefined, true, "capsid's manifest is missing from the dump");
});
