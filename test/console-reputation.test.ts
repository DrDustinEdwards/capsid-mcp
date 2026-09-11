import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConsole } from "../src/console.ts";
import { reputationFrom, type ReputationRows } from "../src/console-reputation.ts";
import type { AgentSummary } from "../src/improve-run.ts";
import { agentRecord } from "./fakes.ts";

// GROUP 3: THE REPUTATION PANEL.
//
// COUNTS, NOT SCORES, and the distinction is the whole design. A score would need a
// weighting, a weighting is an opinion, and an opinion about a credential's
// trustworthiness that a machine computed is the thing nobody should be reading off
// a dashboard. What is here is what happened: jobs this agent finished, failed and
// blocked, pull requests it opened and merged, and for a driver, the attempts its
// namespace kept and reverted.
//
// The aggregation is a pure function over rows so it can be checked against fixtures
// rather than through a fake that would agree with whatever it was handed.

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    name: "capsid-driver",
    kind: "driver",
    namespaces: ["capsid"],
    grants: ["read", "write"],
    flags: [],
    last_seen: "2026-09-11 14:12:01",
    revoked_at: null,
    record: agentRecord(),
    ...overrides,
  };
}

const EMPTY: ReputationRows = { jobs: [], prsOpened: [], prsMerged: [], runs: [] };

test("an agent that has done nothing reports zeroes, not absence", () => {
  const [rep] = reputationFrom([agent()], EMPTY);
  assert.equal(rep.name, "capsid-driver");
  assert.equal(rep.jobs_completed, 0);
  assert.equal(rep.jobs_failed, 0);
  assert.equal(rep.jobs_blocked, 0);
  assert.equal(rep.prs_opened, 0);
  assert.equal(rep.prs_merged, 0);
});

test("job counts come from the actor string, not the agent name", () => {
  const [rep] = reputationFrom([agent()], {
    ...EMPTY,
    jobs: [
      { actor: "agent:capsid-driver", status: "done", n: 4 },
      { actor: "agent:capsid-driver", status: "failed", n: 1 },
      { actor: "agent:capsid-driver", status: "blocked", n: 2 },
      // A bare name is NOT this agent: the queue records agent:<name>, and counting a
      // row that spells it differently would attribute somebody else's work.
      { actor: "capsid-driver", status: "done", n: 99 },
      { actor: "agent:foxing-driver", status: "done", n: 7 },
    ],
  });
  assert.equal(rep.jobs_completed, 4);
  assert.equal(rep.jobs_failed, 1);
  assert.equal(rep.jobs_blocked, 2);
});

test("claimed and queued jobs are not counted as an outcome", () => {
  const [rep] = reputationFrom([agent()], {
    ...EMPTY,
    jobs: [
      { actor: "agent:capsid-driver", status: "claimed", n: 1 },
      { actor: "agent:capsid-driver", status: "done", n: 2 },
    ],
  });
  assert.equal(rep.jobs_completed, 2);
  assert.equal(rep.jobs_failed, 0);
  assert.equal(rep.jobs_blocked, 0);
});

test("pull requests opened and merged are counted per actor", () => {
  const [rep] = reputationFrom([agent()], {
    ...EMPTY,
    prsOpened: [{ actor: "agent:capsid-driver", n: 5 }, { actor: "github:DrDustinEdwards", n: 3 }],
    prsMerged: [{ actor: "github:DrDustinEdwards", n: 3 }],
  });
  assert.equal(rep.prs_opened, 5);
  // The driver holds no can_merge flag, so zero here is the scope working rather
  // than an agent that never got round to it.
  assert.equal(rep.prs_merged, 0);
});

test("a DRIVER carries its namespaces' attempts kept and reverted; other kinds do not", () => {
  const rows: ReputationRows = {
    ...EMPTY,
    runs: [
      { namespace: "capsid", kept: 6, reverts: 14 },
      { namespace: "foxing", kept: 1, reverts: 3 },
    ],
  };
  const [driver] = reputationFrom([agent()], rows);
  assert.equal(driver.attempts_kept, 6);
  assert.equal(driver.attempts_reverted, 14);

  const [seat] = reputationFrom([agent({ name: "seat", kind: "seat", namespaces: ["capsid"] })], rows);
  assert.equal(seat.attempts_kept, null, "attempts belong to a driver's namespace, not to every credential in it");
  assert.equal(seat.attempts_reverted, null);
});

test("a driver scoped to several namespaces sums them; a wildcard driver sums every one", () => {
  const rows: ReputationRows = {
    ...EMPTY,
    runs: [
      { namespace: "capsid", kept: 6, reverts: 14 },
      { namespace: "foxing", kept: 1, reverts: 3 },
      { namespace: "germomics", kept: 2, reverts: 2 },
    ],
  };
  const [pair] = reputationFrom([agent({ name: "pair-driver", namespaces: ["capsid", "foxing"] })], rows);
  assert.equal(pair.attempts_kept, 7);
  assert.equal(pair.attempts_reverted, 17);

  const [all] = reputationFrom([agent({ name: "all-driver", namespaces: "*" })], rows);
  assert.equal(all.attempts_kept, 9);
  assert.equal(all.attempts_reverted, 19);
});

test("a revoked agent keeps its record, and says it is revoked", () => {
  const [rep] = reputationFrom([agent({ name: "old-driver", revoked_at: "2026-09-01 10:00:00" })], {
    ...EMPTY,
    jobs: [{ actor: "agent:old-driver", status: "done", n: 3 }],
  });
  assert.equal(rep.revoked_at, "2026-09-01 10:00:00");
  assert.equal(rep.jobs_completed, 3, "revoking a credential does not unwrite what it did");
});

test("the panel carries the identity a reader needs: kind, namespaces, flags, last_seen", () => {
  const [rep] = reputationFrom([agent({ flags: ["can_merge", "can_dispatch"] })], EMPTY);
  assert.equal(rep.kind, "driver");
  assert.deepEqual(rep.namespaces, ["capsid"]);
  assert.deepEqual(rep.flags, ["can_merge", "can_dispatch"]);
  assert.equal(rep.last_seen, "2026-09-11 14:12:01");
});

test("the panel renders every agent, revoked ones included, and never a key", () => {
  const agents = reputationFrom(
    [
      agent(),
      agent({ name: "seat", kind: "seat", namespaces: "*", flags: ["can_merge"], revoked_at: null }),
      agent({ name: "old-driver", revoked_at: "2026-09-01 10:00:00", last_seen: "2026-08-30 02:00:00" }),
    ],
    {
      ...EMPTY,
      jobs: [{ actor: "agent:capsid-driver", status: "done", n: 4 }],
      runs: [{ namespace: "capsid", kept: 6, reverts: 14 }],
    }
  );
  const html = renderConsole({
    generated: "2026-09-11T14:00:00.000Z",
    viewer: "DrDustinEdwards",
    health: {
      status: "ok",
      sha: "abc1234",
      dirty: false,
      builtAt: null,
      schema_version: "0009_jobs_required_scopes.sql",
      store: { d1: "ok", fts: "ok" },
      backup: { last_ok: "2026-09-11T09:00:00.000Z", age_hours: 5 },
    },
    improve: {
      mode: "subscription",
      mode_note: null,
      cost_note: "estimate",
      budget: {
        month: "2026-09",
        caps: { actions_minutes_month: 2000, model_usd_month: 50 },
        spend: { ci_minutes: 10, cost_usd: 1.5 },
        exceeded: false,
        reason: null,
      },
      protected_paths: [],
      agents,
      namespaces: [],
    },
    activity: [],
    activity_filter: { namespace: null, actor: null },
    agents,
  });
  assert.match(html, /capsid-driver/);
  assert.match(html, /old-driver/);
  // A REVOKED ROW STAYS, and says so: dropping it would make "revoked" and "never
  // existed" look the same, which is the reason listAgents keeps them too.
  assert.match(html, /revoked 2026-09-01 10:00:00/);
  assert.match(html, /can_merge/);
  // "Counts and rates, not scores" is stated on the page, so a reader does not mistake the
  // numbers for a rating.
  assert.match(html, /Counts and rates, not scores/);
  // And the verified column says what it is: only what this Worker checked itself.
  // Without that line the two pull-request columns read as the same measurement.
  assert.match(html, /verified column is only what this Worker checked/);
  // The stored verifier and the fingerprint have no business here.
  assert.doesNotMatch(html, /key_hash|fingerprint/i);
});
