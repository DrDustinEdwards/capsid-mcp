import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultScopes } from "../src/agents-schema.ts";
import { blockJob, completeJob } from "../src/jobs.ts";
import { atCorrectionCap } from "../src/jobs-schema.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";

// GROUP 4, THE BEHAVIOURAL HALF.
//
// test/review.test.ts drives the parser, which is pure. These drive the real
// completeJob and blockJob against a row that can disagree, because a verdict
// computed correctly and then not acted on is exactly what a pure test cannot see.

interface Recorded {
  sql: string;
  params: unknown[];
}

function queueDb(row: Record<string, unknown>) {
  const recorded: Recorded[] = [];
  const stmt = (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...bound: unknown[]) => stmt(sql, bound),
      first: async () => {
        if (/SELECT \* FROM jobs WHERE id = \?1/i.test(flat)) return params[0] === row.id ? { ...row } : null;
        if (/^UPDATE jobs SET/i.test(flat)) {
          recorded.push({ sql: flat, params });
          if (params[0] !== row.id) return null;
          // THE FAKE APPLIES WHAT THE STATEMENT ASKS rather than keeping its own
          // answer. A fake that decided for itself is how a plant deleting a clause
          // leaves a suite green, measured on this repo on 2026-09-12.
          if (/corrections_count = corrections_count \+ 1/.test(flat)) {
            row.corrections_count = Number(row.corrections_count) + 1;
          }
          if (/SET status = \?2/.test(flat)) row.status = params[1];
          if (/SET result_summary = \?2/.test(flat)) row.result_summary = params[1];
          if (/result_summary = COALESCE\(\?3/.test(flat) && params[2] !== null) row.result_summary = params[2];
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
      batch: async (s: unknown[]) => {
        for (const x of s) recorded.push(x as Recorded);
        return [];
      },
    } as unknown as D1Database,
  };
}

function driver() {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  return { id: "agent_dddd", name: "capsid-driver", kind: "driver", actor: "agent:capsid-driver", scopes, admin: false, row: null };
}

const PR = "https://github.com/DrDustinEdwards/capsid-mcp/pull/27";

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_reviewme1234",
    namespace: "capsid",
    title: "work that needs a second reader",
    body: "do the thing",
    priority: 0,
    status: "claimed",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-12T09:00:00.000Z",
    lease_expires: "2026-09-12T13:00:00.000Z",
    result_ref: PR,
    result_summary: null,
    gate_required: 0,
    required_scopes: null,
    min_record: null,
    blocked_count: 0,
    resumed_count: 0,
    corrections_count: 0,
    review_required: 1,
    created_at: "2026-09-12T08:00:00.000Z",
    updated_at: "2026-09-12T09:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-12T12:00:00Z");

async function withComments<T>(bodies: string[], fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(bodies.map((body, i) => ({ user: { login: "reviewer" }, body, created_at: `2026-09-12T1${i}:00:00Z` }))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as never;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function reviewEnv(db: D1Database) {
  return fakeEnv({
    DB: db,
    APP_KV: fakeKv({ seedToken: true }).kv,
    GITHUB_APP_CLIENT_ID: "x",
    GITHUB_APP_PRIVATE_KEY: "x",
    IMPROVE_SCORE_SECRET: "s",
  });
}

const finish = (db: D1Database) =>
  completeJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", { result_summary: "opened PR 27", result_ref: PR });

test("NO REVIEW YET: complete is refused and the job stays claimed", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["nice work"], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false);
    assert.match(String(result.refusal), /no review yet/);
    assert.equal(row.status, "claimed", "a job waiting on a review must not move");
  });
});

test("APPROVE: complete proceeds exactly as it would with no reviewer", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: the scope check is right. APPROVE"], async () => {
    const result = await finish(db);
    assert.equal(result.ok, true, `an approved job was refused: ${JSON.stringify(result)}`);
    assert.equal(row.status, "done");
    assert.equal(row.corrections_count, 0, "an approval must not spend a correction");
  });
});

test("CHANGES: the job goes back to the driver and SPENDS A CORRECTION", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: the error path swallows the refusal. CHANGES"], async () => {
    const result = await finish(db);
    assert.equal(result.ok, false);
    assert.equal(row.status, "claimed", "CHANGES sends the work back to the driver, it does not finish the job");
    assert.equal(row.corrections_count, 1, "a rewrite that costs nothing is a loop with no ceiling");
    assert.match(String(row.result_summary), /CHANGES/);
    assert.match(String(row.result_summary), /error path swallows the refusal/, "the row must carry what the reviewer actually said");
    assert.match(String(result.refusal), /1 of 2/, "the driver is told how much of the budget is left");
  });
});

test("A SECOND CHANGES REACHES THE CAP, so a review loop is bounded by the same ceiling a gate loop is", async () => {
  const { db, row } = queueDb(claimedRow({ corrections_count: 1 }));
  await withComments(["REVIEW: still wrong. CHANGES"], async () => {
    await finish(db);
    assert.equal(row.corrections_count, 2);
    assert.equal(atCorrectionCap(Number(row.corrections_count)), true);
  });
});

test("BLOCK: the job is blocked for the seat, carrying the objection", async () => {
  const { db, row } = queueDb(claimedRow());
  await withComments(["REVIEW: this changes the auth model and needs a ruling. BLOCK"], async () => {
    await finish(db);
    assert.equal(row.status, "blocked");
    assert.match(String(row.result_summary), /BLOCK/);
    assert.match(String(row.result_summary), /needs a ruling/);
    assert.equal(row.corrections_count, 0, "a BLOCK is not a correction; nobody is being asked to fix anything");
  });
});

test("THE GATE IS ON BLOCK TOO, so a driver cannot bypass it by blocking instead", async () => {
  // A gate on one transition is not a gate: the driver would use the other, and the
  // bypass would look like ordinary use.
  const { db, row } = queueDb(claimedRow());
  await withComments(["nothing to see here"], async () => {
    const result = await blockJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", {
      reason: "ready for the seat",
      command: "gh pr merge 27",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.refusal), /no review yet/);
    assert.equal(row.status, "claimed");
  });
});

test("A JOB WITHOUT review_required IS UNTOUCHED, which is almost every job", async () => {
  // The innocent case. If this failed, the gate would hold work nobody asked to have
  // reviewed, and it would be found by an outage rather than by a test.
  const { db, row } = queueDb(claimedRow({ review_required: 0 }));
  const result = await finish(db);
  assert.equal(result.ok, true, `an ordinary job was held by the review gate: ${JSON.stringify(result)}`);
  assert.equal(row.status, "done");
});

test("A JOB WITH NO PULL REQUEST PROCEEDS, because there is nothing for a reviewer to read", async () => {
  const { db, row } = queueDb(claimedRow({ result_ref: null }));
  const result = await completeJob(reviewEnv(db), driver() as never, NOW, "job_reviewme1234", {
    result_summary: "wrote the ruling",
    result_ref: "capsid/decisions.md",
  });
  assert.equal(result.ok, true, `a job that finished with a document was stranded: ${JSON.stringify(result)}`);
  assert.equal(row.status, "done");
});

test("AN UNREADABLE GITHUB HOLDS THE JOB rather than waving it through", async () => {
  // The gate exists to put a second reader in front of the seat. An unreadable comment
  // list is not evidence that one looked, so it must never read as an approval.
  const { db, row } = queueDb(claimedRow());
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream is down", { status: 503 })) as never;
  try {
    const result = await finish(db);
    assert.equal(result.ok, false);
    assert.match(String(result.refusal), /GitHub could not be read/);
    assert.match(String(result.refusal), /rather than treating an unreadable review as an approval/);
    assert.equal(row.status, "claimed");
  } finally {
    globalThis.fetch = original;
  }
});
