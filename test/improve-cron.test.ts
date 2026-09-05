import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chicagoDay, chicagoHour, RUN_STATUSES, TERMINAL_RUN_STATUSES } from "../src/improve-schema.ts";
import { sourceFile } from "./source-files.ts";

// THE CONFIGURATION AND THE HANDLER MUST AGREE.
//
// wrangler.jsonc.example declares which crons fire; src/index.ts decides what to
// do when one does. A cron declared and not handled is a wasted invocation; a
// cron handled and not declared is a subsystem that never runs and says nothing.
// Both are silent, which is the shape this repo keeps ruling against, so the two
// lists are derived from each other here.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

function declaredCrons(): string[] {
  const example = read("../wrangler.jsonc.example");
  const line = /"crons":\s*\[([^\]]+)\]/.exec(example);
  assert.ok(line, "wrangler.jsonc.example no longer declares a crons array");
  const crons = [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // Vacuity guard: an extraction that matched nothing would make both directions
  // below pass over empty lists.
  assert.ok(crons.length > 0, "parsed no cron expressions out of wrangler.jsonc.example");
  return crons;
}

// THE HANDLER'S LIST IS READ FROM SOURCE, not imported.
//
// src/index.ts cannot be imported under node: it pulls in the OAuth provider and
// the agents SDK, which reach for the `cloudflare:` module scheme and fail with
// ERR_UNSUPPORTED_ESM_URL_SCHEME. Reading the exported constants out of the file
// keeps the derivation against the real artifact, which is the property that
// matters; it just cannot be done by evaluating it.
function handlerConstant(name: string): string {
  const index = sourceFile("index.ts");
  const found = new RegExp(`export const ${name} = "([^"]+)";`).exec(index);
  assert.ok(found, `src/index.ts no longer exports ${name}`);
  return found[1];
}

const BACKUP_CRON = handlerConstant("BACKUP_CRON");
const IMPROVE_OPEN_CRON = handlerConstant("IMPROVE_OPEN_CRON");
const IMPROVE_TICK_CRON = handlerConstant("IMPROVE_TICK_CRON");
const IMPROVE_OPEN_HOUR_CT = Number(
  /export const IMPROVE_OPEN_HOUR_CT = (\d+);/.exec(sourceFile("index.ts"))?.[1]
);

const HANDLED = [BACKUP_CRON, IMPROVE_OPEN_CRON, IMPROVE_TICK_CRON];

test("every cron the handler dispatches on is declared in the config", () => {
  const declared = declaredCrons();
  const missing = HANDLED.filter((c) => !declared.includes(c));
  assert.deepEqual(missing, [], `src/index.ts handles crons the config never fires: ${missing.join(", ")}`);
});

test("every cron the config fires is handled", () => {
  const declared = declaredCrons();
  const unhandled = declared.filter((c) => !HANDLED.includes(c));
  assert.deepEqual(unhandled, [], `wrangler.jsonc.example fires crons nothing handles: ${unhandled.join(", ")}`);
});

test("the three are distinct, so the dispatch cannot be ambiguous", () => {
  assert.equal(new Set(HANDLED).size, 3);
});

test("the handler dispatches on controller.cron, not on the clock", () => {
  // 09:00 UTC matches all three expressions and Cloudflare delivers the
  // invocation once per expression. Branching on the time instead of the matched
  // cron would run the wrong body, or all three bodies.
  const index = sourceFile("index.ts");
  assert.match(index, /const cron = controller\.cron;/);
  for (const name of ["BACKUP_CRON", "IMPROVE_OPEN_CRON", "IMPROVE_TICK_CRON"]) {
    assert.match(index, new RegExp(`if \\(cron === ${name}\\)`), `${name} is declared but nothing dispatches on it`);
  }
});

test("each branch is guarded on its own, so one throwing does not stop the others", () => {
  const index = sourceFile("index.ts");
  // Three separate ctx.waitUntil chains, each with its own catch. A shared try
  // would let a failing improve tick cancel the backup.
  assert.equal(index.split("ctx.waitUntil(").length - 1, 3);
  assert.ok(index.split(".catch((err)").length - 1 >= 3, "a cron branch has no catch of its own");
});

// ---- the DST gate -----------------------------------------------------------

test("THE OPENER CRON COVERS BOTH UTC HOURS that can be 03:00 in Chicago", () => {
  // Cloudflare cron expressions are UTC only. 03:00 America/Chicago is 08:00 UTC
  // in CDT and 09:00 in CST, so both fire and chicagoHour decides.
  assert.equal(IMPROVE_OPEN_CRON, "0 8,9 * * *");
  assert.equal(IMPROVE_OPEN_HOUR_CT, 3);
});

test("chicagoHour picks exactly one of the two UTC hours, in BOTH halves of the year", () => {
  // Summer: CDT is UTC-5, so 08:00 UTC is 03:00 local and 09:00 UTC is 04:00.
  assert.equal(chicagoHour(new Date("2026-07-15T08:00:00Z")), 3);
  assert.equal(chicagoHour(new Date("2026-07-15T09:00:00Z")), 4);
  // Winter: CST is UTC-6, so 08:00 UTC is 02:00 local and 09:00 UTC is 03:00.
  assert.equal(chicagoHour(new Date("2026-01-15T08:00:00Z")), 2);
  assert.equal(chicagoHour(new Date("2026-01-15T09:00:00Z")), 3);
  // So exactly one invocation per night opens the run, year round. A hardcoded
  // offset would have opened it twice in summer and at 02:00 in winter.
});

test("chicagoHour normalises midnight to 0, not 24", () => {
  // en-US with hour12 false renders midnight as "24" in some ICU versions and
  // "00" in others. Both mean hour zero, and an unnormalised 24 would never
  // equal any real hour.
  const hour = chicagoHour(new Date("2026-07-15T05:00:00Z"));
  assert.equal(hour, 0);
});

test("chicagoDay is the local day, which is what a run document is named by", () => {
  // 02:00 UTC on the 5th is still the 4th in Chicago. A run opened at 03:00 local
  // must not be filed under tomorrow's date.
  assert.equal(chicagoDay(new Date("2026-09-05T02:00:00Z")), "2026-09-04");
  assert.equal(chicagoDay(new Date("2026-09-04T12:00:00Z")), "2026-09-04");
});

// ---- the terminal statuses --------------------------------------------------

test("THE TERMINAL STATUSES MATCH THE MIGRATION'S PARTIAL UNIQUE INDEX", () => {
  // One active run per namespace is enforced by a partial index that names the
  // terminal statuses in SQL. A status added to the code list and not to the index
  // would let two active runs exist; added to the index and not the code would
  // strand a run nothing advances. Derived in both directions.
  const migration = readFileSync(join(import.meta.dirname, "..", "migrations", "0003_improve.sql"), "utf8");
  const clause = /WHERE status NOT IN \(([^)]+)\)/i.exec(migration);
  assert.ok(clause, "the partial unique index is gone from migrations/0003_improve.sql");
  const inSql = [...clause[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(inSql, [...TERMINAL_RUN_STATUSES].sort());
  // And every terminal status is a real status.
  for (const status of TERMINAL_RUN_STATUSES) {
    assert.ok((RUN_STATUSES as readonly string[]).includes(status), `${status} is terminal but not a run status`);
  }
});

test("the code's own reads use the same terminal set as the index", () => {
  const state = sourceFile("improve-state.ts");
  const occurrences = state.split("status NOT IN ('done', 'paused')").length - 1;
  assert.ok(occurrences >= 2, "the active-run and advanceable-run queries no longer share the terminal set spelling");
});
