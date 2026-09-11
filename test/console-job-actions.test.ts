import assert from "node:assert/strict";
import { test } from "node:test";
import { handleConsoleAction } from "../src/console-actions.ts";
import { consoleSessionCookie } from "../src/console-auth.ts";
import { signTaskBody } from "../src/improve-task.ts";
import { fakeKv } from "./fakes.ts";

// GROUP 7, THE GAP: the two JOB actions, end to end.
//
// The shared fake has no jobs dialect, so the CSRF and confirm tests for resume and
// fail stop before the database. These drive the success path against a stub that
// answers the handful of statements src/jobs.ts issues, and check the thing the job
// asked for: every action writes an audit row.
//
// The stub is deliberately small and deliberately honest about what it answers. It
// resolves the WHERE clauses from the BOUND PARAMS, so a handler asking for the wrong
// id gets nothing, which is the property a fake that matches on SQL shape alone loses.

const SECRET = "console-test-cookie-secret";
const SIGNING = "improve-score-root-secret";
const CSRF = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-09-11T15:00:00Z");

interface Recorded {
  sql: string;
  params: unknown[];
}

function jobsDb(job: Record<string, unknown>) {
  const recorded: Recorded[] = [];
  const row = { ...job };
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement => {
    const flat = sql.replace(/\s+/g, " ").trim();
    return {
      // Carried on the statement itself, the way test/fakes.ts does it, so a
      // statement handed to batch() can be read back. Without this the audit scan
      // finds nothing and reports "not audited" for code that audited correctly.
      sql: flat,
      params,
      bind: (...bound: unknown[]) => stmt(sql, bound),
      first: async () => {
        // The one-claim-per-caller pre-read: this admin holds nothing.
        if (/SELECT \* FROM jobs WHERE status = 'claimed' AND claimed_by/i.test(flat)) return null;
        if (/SELECT \* FROM jobs WHERE id = \?1/i.test(flat)) return params[0] === row.id ? { ...row } : null;
        if (/SELECT id, title, body FROM documents/i.test(flat)) return null;
        if (/^UPDATE jobs SET/i.test(flat)) {
          recorded.push({ sql: flat, params });
          if (params[0] !== row.id) return null;
          // The keyed CAS: only a row in one of the named statuses moves.
          const allowed = /status IN \('queued', 'claimed', 'blocked'\)/.test(flat)
            ? ["queued", "claimed", "blocked"]
            : /status = 'blocked'/.test(flat)
              ? ["blocked"]
              : [];
          if (!allowed.includes(String(row.status))) return null;
          row.status = /SET status = 'failed'/.test(flat) ? "failed" : "claimed";
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

function env(db: D1Database) {
  return {
    DB: db,
    APP_KV: fakeKv().kv,
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_GITHUB_LOGIN: "DrDustinEdwards",
    IMPROVE_SCORE_SECRET: SIGNING,
  } as never;
}

async function post(fields: Record<string, string>): Promise<Request> {
  const session = (await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, NOW)).split(";")[0];
  return new Request("https://capsid.example/console", {
    method: "POST",
    headers: {
      Cookie: `${session}; capsid_console_csrf=${CSRF}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ...fields, csrf: CSRF, confirm: "yes" }).toString(),
  });
}

async function blockedJob(): Promise<Record<string, unknown>> {
  return {
    id: "job_1",
    namespace: "capsid",
    title: "a blocked job",
    body: await signTaskBody(SIGNING, "do the thing"),
    priority: 0,
    status: "blocked",
    posted_by: "github:DrDustinEdwards",
    claimed_by: "agent:capsid-driver",
    claimed_at: "2026-09-11T10:00:00Z",
    lease_expires: null,
    result_ref: null,
    result_summary: "waiting on the push",
    gate_required: 1,
    created_at: "2026-09-11T09:00:00Z",
    updated_at: "2026-09-11T10:00:00Z",
    resumed_count: 0,
    blocked_count: 1,
    required_scopes: null,
  };
}

function auditRows(recorded: Recorded[]): Recorded[] {
  return recorded.filter((r) => typeof r.sql === "string" && /INSERT INTO audit_log/i.test(r.sql));
}

test("fail_job marks a blocked job failed and writes BOTH audit rows", async () => {
  const { db, recorded, row } = jobsDb(await blockedJob());
  const res = await handleConsoleAction(await post({ action: "fail_job", id: "job_1", reason: "superseded" }), env(db), NOW);
  assert.equal(res.status, 303, `expected a redirect, got ${res.status}: ${await res.text()}`);
  assert.equal(row.status, "failed");
  const audits = auditRows(recorded);
  // The transition's own row, and the console's row naming the human.
  assert.ok(
    audits.some((r) => r.params.includes("job-admin-fail")),
    `the transition was not audited: ${JSON.stringify(audits.map((a) => a.params))}`
  );
  assert.ok(
    audits.some((r) => r.params.includes("console-fail_job") && r.params.includes("github:DrDustinEdwards")),
    "the click was not audited against the admin"
  );
});

test("the admin fail is a keyed UPDATE: it refuses a job that is already finished", async () => {
  const { db, recorded } = jobsDb({ ...(await blockedJob()), status: "done" });
  const res = await handleConsoleAction(await post({ action: "fail_job", id: "job_1", reason: "too late" }), env(db), NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /already done/);
  assert.deepEqual(auditRows(recorded), [], "a refused fail wrote an audit row");
});

test("fail_job refuses a job id that does not exist, rather than reporting a no-op as success", async () => {
  const { db } = jobsDb(await blockedJob());
  const res = await handleConsoleAction(await post({ action: "fail_job", id: "job_missing", reason: "x" }), env(db), NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no job job_missing/);
});

test("resume_job moves a blocked job back to claimed and audits the approval reason", async () => {
  const { db, recorded, row } = jobsDb(await blockedJob());
  const res = await handleConsoleAction(
    await post({ action: "resume_job", id: "job_1", reason: "I ran the push myself" }),
    env(db),
    NOW
  );
  assert.equal(res.status, 303, `expected a redirect, got ${res.status}: ${await res.text()}`);
  assert.equal(row.status, "claimed");
  const audits = auditRows(recorded);
  assert.ok(audits.some((r) => r.params.includes("job-resumed")), "the resume was not audited");
  const click = audits.find((r) => r.params.includes("console-resume_job"));
  assert.ok(click, "the click was not audited");
  assert.ok(
    click.params.some((p) => typeof p === "string" && p.includes("I ran the push myself")),
    `the approval reason is not in the audit row: ${JSON.stringify(click.params)}`
  );
});

test("resume_job REFUSES a job whose body was edited after it was signed", async () => {
  // A blocked job sits in the table for as long as a human takes, which is the window
  // in which a row could be edited. Resume re-verifies for that reason, and the
  // console must surface the refusal rather than redirecting as though it worked.
  const { db } = jobsDb({ ...(await blockedJob()), body: "---\ncapsid-task-signature: deadbeef\n---\ntampered" });
  const res = await handleConsoleAction(
    await post({ action: "resume_job", id: "job_1", reason: "approved" }),
    env(db),
    NOW
  );
  assert.equal(res.status, 400);
  assert.match(await res.text(), /signature/i);
});

test("resume_job needs an approval reason, and says why", async () => {
  const { db, recorded } = jobsDb(await blockedJob());
  const res = await handleConsoleAction(await post({ action: "resume_job", id: "job_1", reason: "  " }), env(db), NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /what you approved/i);
  assert.deepEqual(auditRows(recorded), []);
});

test("fail_job needs a reason too", async () => {
  const { db } = jobsDb(await blockedJob());
  const res = await handleConsoleAction(await post({ action: "fail_job", id: "job_1", reason: "" }), env(db), NOW);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /reason/i);
});
