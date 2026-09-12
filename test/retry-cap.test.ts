import assert from "node:assert/strict";
import { test } from "node:test";
import { CORRECTION_CAP, RETRY_CAP_REASON, atCorrectionCap, cappedSummary } from "../src/jobs-schema.ts";
import { sourceFile } from "./source-files.ts";
import { defaultScopes } from "../src/agents-schema.ts";
import { resumeJob } from "../src/jobs.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeEnv } from "./fakes.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// GROUP 2: TWO CORRECTIONS, THEN A HUMAN.
//
// `resume` made a gate a pause rather than an ending, which is right. What it left
// unbounded is the LOOP: block, sent back, block again, sent back again, block
// again. Every step is defensible on its own and the composition is not, so the
// ceiling is counted rather than judged.
//
// The rules live as pure functions here for the same reason the skill lifecycle
// does: they can be driven to their refusals without a database.

test("the cap is two, and it is stated once", () => {
  assert.equal(CORRECTION_CAP, 2);
});

test("a job under the cap is not capped, and a job at it is", () => {
  assert.equal(atCorrectionCap(0), false);
  assert.equal(atCorrectionCap(1), false, "one correction is a driver fixing something, not a loop");
  assert.equal(atCorrectionCap(2), true, "the third block is the one a human decides");
  assert.equal(atCorrectionCap(9), true);
});

test("a corrupt or negative count is treated as at the cap, not under it", () => {
  // Fail closed. A count this function cannot read is a count it cannot bound, and
  // waving that through would hand the loop exactly the case nobody tested.
  assert.equal(atCorrectionCap(Number.NaN), true);
  assert.equal(atCorrectionCap(-1), true);
});

test("the capped summary names the cap and KEEPS what the driver said", () => {
  const summary = cappedSummary("the push needs a human");
  assert.match(summary, new RegExp(RETRY_CAP_REASON));
  assert.match(summary, /the push needs a human/, "a cap that discards the driver's summary throws away what the human has to decide about");
});

test("capping an empty summary still says why the job stopped", () => {
  assert.match(cappedSummary(null), new RegExp(RETRY_CAP_REASON));
  assert.match(cappedSummary(""), new RegExp(RETRY_CAP_REASON));
});

test("the reason is the exact string the job asked for", () => {
  assert.equal(RETRY_CAP_REASON, "retry cap; human decision required");
});

test("DERIVED: the column the cap is counted in exists in a migration", () => {
  // The rules above are worth nothing if nothing stores the count. Read the
  // migrations rather than trusting that one was written.
  const dir = join(import.meta.dirname, "..", "migrations");
  const names = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  assert.ok(names.length > 0, "the scan found no migrations; it is reading nothing");
  const sql = names.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.match(sql, /ALTER TABLE jobs ADD COLUMN corrections_count INTEGER NOT NULL DEFAULT 0/);
});

test("DERIVED: resume spends the budget and an ADMIN resume does not", () => {
  // The cap puts a human at the boundary, so the human arriving must be what LIFTS
  // it rather than what spends it. Read from the source, because this is a branch
  // the unit rules above cannot see.
  const jobs = sourceFile("jobs.ts");
  assert.match(jobs, /corrections_count = corrections_count \+ \?\d/, "resume does not increment the budget, so the cap can never be reached");
  assert.match(jobs, /agent\.admin/, "nothing in jobs.ts distinguishes an admin resume, so an admin cannot lift the cap");
});

test("DERIVED: block is where the cap is applied", () => {
  const jobs = sourceFile("jobs.ts");
  assert.match(jobs, /cappedSummary/, "block never writes the capped summary, so a capped job reads like an ordinary one");
});

// ---- the behavioural half, against a row that can disagree -----------------------
//
// The rules above are pure and the branch that uses them is not. These drive the real
// resumeJob against a fake D1 that holds a row, so a cap that is computed correctly
// and then never consulted is caught here rather than in production.

interface Recorded {
  sql: string;
  params: unknown[];
}

function resumeDb(row: Record<string, unknown>) {
  const recorded: Recorded[] = [];
  const stmt = (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...bound: unknown[]) => stmt(sql, bound),
      first: async () => {
        if (/SELECT \* FROM jobs WHERE status = 'claimed' AND claimed_by/i.test(flat)) return null;
        if (/SELECT \* FROM jobs WHERE id = \?1/i.test(flat)) return params[0] === row.id ? { ...row } : null;
        if (/SELECT id, title, body FROM documents/i.test(flat)) return null;
        if (/^UPDATE jobs SET/i.test(flat)) {
          recorded.push({ sql: flat, params });
          if (params[0] !== row.id || row.status !== "blocked") return null;
          row.status = "claimed";
          // The fake APPLIES the increment the statement asks for rather than
          // assuming it. A fake that kept its own answer is how a plant deleting the
          // clause leaves a suite green (test/skills-records.test.ts, 2026-09-12).
          const spend = params[4];
          if (typeof spend === "number") row.corrections_count = Number(row.corrections_count) + spend;
          return { id: row.id };
        }
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({}),
      raw: async () => [],
    } as unknown as D1PreparedStatement;
  };
  return {
    recorded,
    row,
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async (statements: unknown[]) => {
        for (const s of statements) recorded.push(s as Recorded);
        return [];
      },
    } as unknown as D1Database,
  };
}

function agentNamed(name: string, admin: boolean) {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_aaaabbbbcccc", name, kind: admin ? "seat" : "driver", actor: `agent:${name}`, scopes, admin, row: null };
}

async function blockedRow(corrections: number) {
  return {
    id: "job_4c0ecc28548b",
    namespace: "capsid",
    title: "a job that keeps hitting the same wall",
    body: await signTaskBody(SECRET, "Do the thing."),
    priority: 0,
    status: "blocked",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-12T00:00:00.000Z",
    lease_expires: null,
    result_ref: null,
    result_summary: "stopped at the push",
    gate_required: 1,
    created_at: "2026-09-11T22:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z",
    resumed_count: corrections,
    blocked_count: corrections + 1,
    corrections_count: corrections,
    required_scopes: null,
    min_record: null,
  };
}

const SECRET = "retry-cap-test-secret";
const NOW = new Date("2026-09-12T03:00:00Z");

test("the first two resumes are allowed, and each one spends the budget", async () => {
  // The innocent case first: a cap that refused ordinary work would be found by an
  // outage rather than by a test.
  for (const corrections of [0, 1]) {
    const { db, row } = resumeDb(await blockedRow(corrections));
    const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
    const result = await resumeJob(env, agentNamed("capsid-driver", false) as never, NOW, "job_4c0ecc28548b", "the human ran it");
    assert.equal(result.ok, true, `resume ${corrections + 1} refused: ${JSON.stringify(result)}`);
    assert.equal(row.corrections_count, corrections + 1, "a resume that does not spend the budget can never reach the cap");
  }
});

test("THE THIRD RESUME IS REFUSED, and the refusal names the cap", async () => {
  const { db, row } = resumeDb(await blockedRow(CORRECTION_CAP));
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  const result = await resumeJob(env, agentNamed("capsid-driver", false) as never, NOW, "job_4c0ecc28548b", "one more go");
  assert.equal(result.ok, false);
  assert.match(String(result.refusal), new RegExp(RETRY_CAP_REASON));
  assert.match(String(result.refusal), /admin caller may resume it/, "a refusal that does not say who CAN act leaves the job stuck with no route out");
  assert.equal(row.status, "blocked", "a refused resume must leave the job exactly as it was");
  assert.equal(row.corrections_count, CORRECTION_CAP, "a refused resume must not spend the budget it was refused for");
});

test("THE SEAT IS ALSO REFUSED at the cap, because the seat is not the human", async () => {
  // The seat holds a write grant and can_merge and is still a machine. If the cap
  // stopped at "not a driver" it would be lifted by the party it exists to bound.
  const { db } = resumeDb(await blockedRow(CORRECTION_CAP));
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  const result = await resumeJob(env, agentNamed("seat", false) as never, NOW, "job_4c0ecc28548b", "the seat says go");
  assert.equal(result.ok, false);
  assert.match(String(result.refusal), new RegExp(RETRY_CAP_REASON));
});

test("AN ADMIN RESUME IS ALLOWED at the cap, and does not spend the budget", async () => {
  const { db, row } = resumeDb(await blockedRow(CORRECTION_CAP));
  const env = fakeEnv({ DB: db, IMPROVE_SCORE_SECRET: SECRET });
  const result = await resumeJob(env, agentNamed("admin", true) as never, NOW, "job_4c0ecc28548b", "I looked at it and it is fine");
  assert.equal(result.ok, true, `an admin resume was refused: ${JSON.stringify(result)}`);
  assert.equal(row.status, "claimed");
  assert.equal(
    row.corrections_count,
    CORRECTION_CAP,
    "an admin resume that spent the budget would push the job further past a cap the admin just cleared"
  );
});
