import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLES } from "../scripts/mint-agents.mjs";
import { allowsToolAction } from "../src/agents-schema.ts";
import { checkScope } from "../src/scope.ts";
import {
  BLOCKED_STALE_HOURS,
  BUDGET_WARN_FRACTION,
  CI_RED_HOURS,
  DEFAULT_CADENCE_MINUTES,
  MAX_FINDINGS_PER_PASS,
  MIN_CADENCE_MINUTES,
  WATCHER_ACTOR,
  WATCHER_CADENCE_KEY,
  WATCHER_LAST_KEY,
  WATCHER_NAME,
  cadenceMinutes,
  ciFindings,
  clearFinding,
  newestMigration,
  openWatcherFingerprints,
  readStaleBlocked,
  healthFindings,
  passDue,
  runPass,
  staleBlockedFindings,
  statusFindings,
  watcherAgent,
  type Finding,
} from "../src/watcher.ts";

// GROUP 3: A WATCHER THAT CANNOT FIX ANYTHING.
//
// The checks are pure functions of what a surface said, so every one of them is
// driven here without a Worker, a database or GitHub. The property that matters most
// is the NEGATIVE one: a healthy surface posts nothing. A watcher that cried every
// half hour would be muted inside a week and would then be worth less than nothing,
// because the queue would still look like it was being watched.

const NOW = new Date("2026-09-12T12:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();

const HEALTHY = {
  status: "ok" as const,
  sha: "1d6912efc2225d3725bfdc8ad5e6e5cae8dec63d",
  dirty: false,
  builtAt: null,
  schema_version: "0016_jobs_retry_cap.sql",
  store: { d1: "ok", fts: "ok" },
  backup: { last_ok: hoursAgo(2), age_hours: 2 },
};

// ---- the identity ----------------------------------------------------------------

test("the in-Worker watcher is the SAME authority as the mintable role, not a convenient one", () => {
  // The role a person mints and the identity the tick uses must not drift. If the
  // in-Worker one quietly held more, the mint command would be describing a
  // credential that is not the one doing the work.
  const role = ROLES.find((r: (typeof ROLES)[number]) => r.name === "watcher");
  assert.ok(role);
  const agent = watcherAgent();
  assert.deepEqual(agent.scopes.tools, role.tools);
  assert.deepEqual(Object.entries(agent.scopes.flags).filter(([, on]) => on), [], "the watcher must hold no flag");
  assert.equal(agent.actor, WATCHER_ACTOR);
});

test("the watcher can post a job and cannot claim, complete or resume one", () => {
  const agent = watcherAgent();
  assert.equal(checkScope(agent, { tool: "jobs", action: "post", namespace: "capsid", grant: "write" }), null);
  for (const action of ["claim", "complete", "fail", "block", "resume", "heartbeat"]) {
    assert.match(
      String(checkScope(agent, { tool: "jobs", action, namespace: "capsid", grant: "write" })),
      new RegExp(`jobs\\.${action}`),
      `the watcher was allowed to ${action} a job`
    );
  }
  // And nothing outside the queue at all.
  assert.match(String(checkScope(agent, { tool: "write", namespace: "capsid", grant: "write" })), /not scoped to the 'write' tool/);
  assert.match(String(checkScope(agent, { tool: "manage_pr", namespace: "capsid", grant: "write" })), /not scoped to the 'manage_pr' tool/);
});

// ---- the cadence -----------------------------------------------------------------

test("the cadence is half an hour and its floor is five minutes", () => {
  assert.equal(DEFAULT_CADENCE_MINUTES, 30);
  assert.equal(MIN_CADENCE_MINUTES, 5);
});

test("a pass is due on the first run, not due inside the cadence, and due after it", () => {
  assert.equal(passDue(null, 30, NOW).due, true);
  assert.equal(passDue(hoursAgo(0.25), 30, NOW).due, false, "15 minutes into a 30 minute cadence is not due");
  assert.equal(passDue(hoursAgo(1), 30, NOW).due, true);
});

test("a corrupt stamp RUNS the pass rather than blocking it forever", () => {
  const verdict = passDue("not a date", 30, NOW);
  assert.equal(verdict.due, true);
  assert.match(verdict.reason, /does not parse/);
});

// ---- a healthy surface posts nothing ----------------------------------------------

test("A HEALTHY SURFACE PRODUCES NO FINDING AT ALL", () => {
  // The innocent case, first and loudest. Every assertion below is worthless if this
  // one does not hold.
  assert.deepEqual(healthFindings(HEALTHY, HEALTHY.sha, HEALTHY.schema_version, "capsid"), []);
  assert.deepEqual(staleBlockedFindings([], NOW), []);
  assert.deepEqual(ciFindings("capsid", [{ head_sha: "abc1234", status: "completed", conclusion: "success", created_at: hoursAgo(9) }], NOW), []);
  assert.deepEqual(
    statusFindings(
      {
        budget: { month: "2026-09", caps: { actions_minutes_month: 300, model_usd_month: 50 }, spend: { ci_minutes: 10, cost_usd: 1 }, exceeded: false, reason: null },
        namespaces: [{ namespace: "capsid", paused: null }],
      } as never,
      NOW
    ),
    []
  );
});

// ---- each check, once ------------------------------------------------------------

test("a degraded store is a finding", () => {
  const found = healthFindings({ ...HEALTHY, status: "degraded", store: { d1: "error", fts: "ok" } }, HEALTHY.sha, HEALTHY.schema_version, "capsid");
  assert.equal(found.length, 1);
  assert.equal(found[0].fingerprint, "health-degraded");
  assert.match(found[0].body, /d1 error/, "a finding with no evidence is a rumour");
});

test("a deployed sha that is not master head is a finding", () => {
  const found = healthFindings(HEALTHY, "0360787aaaabbbbccccddddeeeeffff0011223344", HEALTHY.schema_version, "capsid");
  assert.equal(found.length, 1);
  assert.match(found[0].fingerprint, /^deploy-drift-0360787$/);
  assert.match(found[0].body, /deployed: 1d6912e/);
});

test("an UNKNOWN master sha is not drift, because that is a finding about the watcher", () => {
  assert.deepEqual(healthFindings(HEALTHY, null, HEALTHY.schema_version, "capsid"), []);
  assert.deepEqual(healthFindings({ ...HEALTHY, sha: "unknown" }, "0360787", HEALTHY.schema_version, "capsid"), []);
});

test("a backup older than the window, and one that never ran, are different findings", () => {
  const stale = healthFindings({ ...HEALTHY, backup: { last_ok: hoursAgo(30), age_hours: 30 } }, HEALTHY.sha, HEALTHY.schema_version, "capsid");
  assert.deepEqual(stale.map((f) => f.fingerprint), ["backup-stale"]);
  const never = healthFindings({ ...HEALTHY, backup: { last_ok: null, age_hours: null } }, HEALTHY.sha, HEALTHY.schema_version, "capsid");
  assert.deepEqual(never.map((f) => f.fingerprint), ["backup-never"]);
});

test("a live schema behind the newest migration is a finding", () => {
  const found = healthFindings(HEALTHY, HEALTHY.sha, "0017_something_new.sql", "capsid");
  assert.deepEqual(found.map((f) => f.fingerprint), ["schema-behind-0017_something_new.sql"]);
});

test("a blocked job over the window is a finding, and one under it is not", () => {
  const row = { id: "job_abc", namespace: "capsid", title: "a job", result_summary: "stopped at the push\n\nRun this:", updated_at: hoursAgo(BLOCKED_STALE_HOURS + 1) };
  const found = staleBlockedFindings([row], NOW);
  assert.deepEqual(found.map((f) => f.fingerprint), ["blocked-job_abc"]);
  assert.match(found[0].body, /stopped at the push/);
  assert.doesNotMatch(found[0].body, /Run this:/, "a finding carries the headline, not the whole resume command");
  assert.deepEqual(staleBlockedFindings([{ ...row, updated_at: hoursAgo(BLOCKED_STALE_HOURS - 1) }], NOW), []);
});

test("a PAUSE A HUMAN SET is not a finding, and one the loop set is", () => {
  // A human pausing a namespace is the system working. Reporting it would teach the
  // reader to ignore the watcher, which is the failure mode that matters most.
  const report = (paused: string | null) =>
    statusFindings(
      {
        budget: { month: "2026-09", caps: { actions_minutes_month: 300, model_usd_month: 50 }, spend: { ci_minutes: 0, cost_usd: 0 }, exceeded: false, reason: null },
        namespaces: [{ namespace: "foxing", paused }],
      } as never,
      NOW
    );
  assert.deepEqual(report("Dustin is rewriting the scorer"), []);
  assert.deepEqual(report(null), []);
  assert.deepEqual(report("budget exceeded for 2026-09").map((f) => f.fingerprint), ["paused-foxing"]);
  assert.deepEqual(report("anchor checksum drift").map((f) => f.fingerprint), ["paused-foxing"]);
});

test("a budget over the warning fraction is a finding, per cap", () => {
  const found = statusFindings(
    {
      budget: {
        month: "2026-09",
        caps: { actions_minutes_month: 300, model_usd_month: 50 },
        spend: { ci_minutes: 290, cost_usd: 45 },
        exceeded: false,
        reason: null,
      },
      namespaces: [],
    } as never,
    NOW
  );
  assert.deepEqual(found.map((f) => f.fingerprint).sort(), ["budget-actions_minutes_month-2026-09", "budget-model_usd_month-2026-09"]);
  // Just under the line is not a finding, so the threshold is a line rather than a mood.
  const under = statusFindings(
    {
      budget: {
        month: "2026-09",
        caps: { actions_minutes_month: 100, model_usd_month: 100 },
        spend: { ci_minutes: BUDGET_WARN_FRACTION * 100 - 1, cost_usd: BUDGET_WARN_FRACTION * 100 - 1 },
        exceeded: false,
        reason: null,
      },
      namespaces: [],
    } as never,
    NOW
  );
  assert.deepEqual(under, []);
});

test("CI red for longer than a flake is a finding, and a fresh red is not", () => {
  const red = (hours: number) => [{ head_sha: "deadbee1234", status: "completed", conclusion: "failure", created_at: hoursAgo(hours) }];
  assert.deepEqual(ciFindings("capsid", red(CI_RED_HOURS + 1), NOW).map((f) => f.fingerprint), ["ci-red-deadbee"]);
  assert.deepEqual(ciFindings("capsid", red(CI_RED_HOURS - 1), NOW), [], "a red run somebody is already fixing is not a finding");
});

test("a run still in flight is not an answer either way", () => {
  const inFlight = [{ head_sha: "deadbee1234", status: "in_progress", conclusion: null, created_at: hoursAgo(9) }];
  assert.deepEqual(ciFindings("capsid", inFlight, NOW), []);
});

// ---- the pass ---------------------------------------------------------------------

function fakeFinding(fingerprint: string, namespace = "capsid"): Finding {
  return { fingerprint, namespace, title: `Watcher: something [${fingerprint}]`, body: "evidence" };
}

function harness(found: Finding[], open: Map<string, string>) {
  const posted: Finding[] = [];
  const cleared: string[] = [];
  return {
    posted,
    cleared,
    readers: {
      findings: async () => found,
      open: async () => open,
      clear: async (id: string) => {
        cleared.push(id);
        return true;
      },
      post: async (f: Finding) => {
        posted.push(f);
        return { ok: true };
      },
    },
  };
}

test("EACH FINDING POSTS EXACTLY ONCE, and a second pass posts nothing", async () => {
  const first = harness([fakeFinding("ci-red-abc")], new Map());
  const one = await runPass(first.readers);
  assert.deepEqual(one.posted, ["ci-red-abc"]);
  assert.equal(first.posted.length, 1);

  // The same finding, now with its job open. The queue's own duplicate rule would
  // refuse it; the pass does not even ask, so the log does not fill with refusals.
  const second = harness([fakeFinding("ci-red-abc")], new Map([["ci-red-abc", "job_1"]]));
  const two = await runPass(second.readers);
  assert.deepEqual(two.posted, []);
  assert.equal(second.posted.length, 0, "a finding already open must not be posted again");
});

test("A CLEARED FINDING CLOSES ITS JOB, and a finding still being found does not", async () => {
  const h = harness([fakeFinding("still-broken")], new Map([["still-broken", "job_1"], ["went-away", "job_2"]]));
  const result = await runPass(h.readers);
  assert.deepEqual(result.cleared, ["went-away"]);
  assert.deepEqual(h.cleared, ["job_2"], "a finding that is still being found must keep its job");
});

test("A HEALTHY PASS POSTS NOTHING AND CLOSES NOTHING", async () => {
  const h = harness([], new Map());
  const result = await runPass(h.readers);
  assert.deepEqual(result, { posted: [], cleared: [] });
});

test("clearing runs BEFORE posting, so a finding that flickers is not refused as its own duplicate", async () => {
  // The order matters and is easy to get backwards. If the post ran first, a finding
  // whose job was about to be closed would be refused as a duplicate of it.
  const order: string[] = [];
  await runPass({
    findings: async () => [fakeFinding("b")],
    open: async () => new Map([["a", "job_a"]]),
    clear: async (id) => {
      order.push(`clear:${id}`);
      return true;
    },
    post: async (f) => {
      order.push(`post:${f.fingerprint}`);
      return { ok: true };
    },
  });
  assert.deepEqual(order, ["clear:job_a", "post:b"]);
});

test("a pass posts at most its bound, and the rest are found again next time", async () => {
  const many = Array.from({ length: MAX_FINDINGS_PER_PASS + 5 }, (_, i) => fakeFinding(`f-${i}`));
  const h = harness(many, new Map());
  const result = await runPass(h.readers);
  assert.equal(result.posted.length, MAX_FINDINGS_PER_PASS);
});

test("a refused post is logged and does not stop the rest of the pass", async () => {
  const posted: string[] = [];
  const result = await runPass({
    findings: async () => [fakeFinding("first"), fakeFinding("second")],
    open: async () => new Map(),
    clear: async () => true,
    post: async (f) => {
      posted.push(f.fingerprint);
      return f.fingerprint === "first" ? { ok: false, refusal: "a duplicate is already open" } : { ok: true };
    },
  });
  assert.deepEqual(posted, ["first", "second"], "a refusal on one finding must not abandon the others");
  assert.deepEqual(result.posted, ["second"], "only what actually posted is reported as posted");
});

test("the fingerprint round-trips through the title, which is what deduplicates", () => {
  // The title is the dedup key, so a fingerprint that cannot be read back out of it
  // would post the same finding every half hour forever.
  const f = healthFindings({ ...HEALTHY, status: "degraded" }, HEALTHY.sha, HEALTHY.schema_version, "capsid")[0];
  const match = /\[([^\]]+)\]\s*$/.exec(f.title);
  assert.ok(match, `no fingerprint in '${f.title}'`);
  assert.equal(match[1], f.fingerprint);
});

test("DERIVED: every finding this module can produce carries a readable fingerprint", () => {
  const all: Finding[] = [
    ...healthFindings({ ...HEALTHY, status: "degraded", backup: { last_ok: null, age_hours: null } }, "0360787", "0099_x.sql", "capsid"),
    ...staleBlockedFindings([{ id: "job_z", namespace: "foxing", title: "t", result_summary: null, updated_at: hoursAgo(99) }], NOW),
    ...ciFindings("germomics", [{ head_sha: "feedface99", status: "completed", conclusion: "failure", created_at: hoursAgo(9) }], NOW),
  ];
  assert.ok(all.length >= 5, `the scan produced only ${all.length} findings; it is reading nothing`);
  for (const f of all) {
    const match = /\[([^\]]+)\]\s*$/.exec(f.title);
    assert.ok(match, `no fingerprint in '${f.title}'`);
    assert.equal(match[1], f.fingerprint);
    assert.ok(f.namespace.length > 0, "a finding with no namespace has nowhere to be posted");
    assert.match(f.body, /Evidence/, "a finding with no evidence section is a rumour");
  }
});

test("allowsToolAction is what makes the watcher's narrowing real", () => {
  const agent = watcherAgent();
  assert.equal(allowsToolAction(agent.scopes.tools, "jobs", "post"), true);
  assert.equal(allowsToolAction(agent.scopes.tools, "jobs", "claim"), false);
});

// ---- the pieces the pass is built from -------------------------------------------
//
// These are exported because they carry rules worth guarding, not because something
// outside the module calls them. The dead-export check is what asks for this, and the
// right answer to it is a caller rather than an exemption.

test("the cadence keys are the ones a human sets, spelled once", () => {
  assert.equal(WATCHER_NAME, "watcher");
  assert.equal(WATCHER_CADENCE_KEY, "watcher:cadence-minutes");
  assert.equal(WATCHER_LAST_KEY, "watcher:last");
});

test("an unset, unusable or unreadable cadence falls back to the default", async () => {
  const env = (get: () => Promise<string | null>) => ({ APP_KV: { get } }) as never;
  assert.equal(await cadenceMinutes(env(async () => null)), DEFAULT_CADENCE_MINUTES);
  assert.equal(await cadenceMinutes(env(async () => "0")), DEFAULT_CADENCE_MINUTES, "zero would run every check on every tick");
  assert.equal(await cadenceMinutes(env(async () => "-5")), DEFAULT_CADENCE_MINUTES);
  assert.equal(await cadenceMinutes(env(async () => "not a number")), DEFAULT_CADENCE_MINUTES);
  assert.equal(
    await cadenceMinutes(
      env(async () => {
        throw new Error("KV is down");
      })
    ),
    DEFAULT_CADENCE_MINUTES,
    "an unreadable store must fall back to the safe value, not to whatever was last in memory"
  );
  // And a usable value IS obeyed, so the fallback is a floor rather than a ceiling.
  assert.equal(await cadenceMinutes(env(async () => "120")), 120);
  assert.equal(await cadenceMinutes(env(async () => "7.9")), 7, "a fractional cadence floors rather than being refused");
});

test("newestMigration takes the last by name, and ignores what is not a migration", () => {
  assert.equal(newestMigration(["0001_init.sql", "0016_jobs_retry_cap.sql", "0002_links.sql"]), "0016_jobs_retry_cap.sql");
  assert.equal(newestMigration(["README.md"]), null);
  assert.equal(newestMigration([]), null);
});

test("openWatcherFingerprints reads only QUEUED jobs the watcher itself posted", async () => {
  const seen: unknown[][] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        const flat = sql.replace(/\s+/g, " ");
        assert.match(flat, /posted_by = \?1/, "a read that is not keyed on the watcher would adopt other people's jobs");
        assert.match(flat, /status = 'queued'/, "a job a driver has claimed is the driver's, not the watcher's to close");
        return {
          bind: (...b: unknown[]) => {
            seen.push(b);
            return {
              all: async () => ({
                results: [
                  { id: "job_1", title: "Watcher: something [ci-red-abc]" },
                  { id: "job_2", title: "a job with no fingerprint" },
                ],
              }),
            };
          },
        };
      },
    },
  } as never;
  const open = await openWatcherFingerprints(env);
  assert.deepEqual(seen, [[WATCHER_ACTOR]]);
  assert.deepEqual([...open.entries()], [["ci-red-abc", "job_1"]], "a title with no fingerprint is not a watcher finding");
});

test("clearFinding is a keyed UPDATE that cannot close somebody else's job", async () => {
  let bound: unknown[] = [];
  let flat = "";
  const env = {
    DB: {
      prepare: (sql: string) => {
        flat = sql.replace(/\s+/g, " ");
        return {
          bind: (...b: unknown[]) => {
            bound = b;
            return { first: async () => ({ id: "job_1" }) };
          },
        };
      },
    },
  } as never;
  assert.equal(await clearFinding(env, "job_1", NOW), true);
  assert.match(flat, /status = 'queued'/, "a claimed job must not be closed underneath its driver");
  assert.match(flat, /posted_by = \?4/);
  assert.match(flat, /RETURNING id/, "D1's meta.changes is inflated by the FTS triggers and cannot count what this moved");
  assert.equal(bound[1], "cleared", "the reason is the honest word: nobody did the work, it stopped being true");
  assert.equal(bound[3], WATCHER_ACTOR);
});

test("clearFinding reports FALSE when it moved nothing, so a race is visible", async () => {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
  } as never;
  assert.equal(await clearFinding(env, "job_1", NOW), false);
});

test("readStaleBlocked asks for blocked jobs older than the window, bounded", async () => {
  let flat = "";
  let bound: unknown[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        flat = sql.replace(/\s+/g, " ");
        return {
          bind: (...b: unknown[]) => {
            bound = b;
            return { all: async () => ({ results: [] }) };
          },
        };
      },
    },
  } as never;
  await readStaleBlocked(env, NOW);
  assert.match(flat, /status = 'blocked'/);
  assert.match(flat, /updated_at < \?1/);
  assert.match(flat, /LIMIT 20/, "an unbounded read is one that times out on the day it matters");
  const cutoff = Date.parse(String(bound[0]));
  assert.equal(NOW.getTime() - cutoff, BLOCKED_STALE_HOURS * 3_600_000);
});
