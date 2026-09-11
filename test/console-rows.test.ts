import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConsole, type ConsoleData } from "../src/console.ts";
import type { NamespaceStatus } from "../src/improve-run.ts";
import type { AgentReputation } from "../src/console-reputation.ts";

// GROUP 2: THE NAMESPACE ROWS.
//
// What a person opens the console to find out. The row is a projection of
// NamespaceStatus, which is what improve_status already returns, so these tests are
// about what reaches the page rather than about how it was queried: the second query
// path the job rules out would show up here as a field the row can render that
// NamespaceStatus cannot supply.
//
// THE BLOCKED JOB IS THE POINT. A count of blocked jobs tells nobody what to run, so
// the row carries the command each one is waiting on, verbatim. That is the one piece
// of this page that turns "something is stuck" into an action.

function health(): ConsoleData["health"] {
  return {
    status: "ok",
    sha: "abc1234",
    dirty: false,
    builtAt: null,
    schema_version: "0009_jobs_required_scopes.sql",
    store: { d1: "ok", fts: "ok" },
    backup: { last_ok: "2026-09-11T09:00:00.000Z", age_hours: 5 },
  };
}

function namespaceStatus(overrides: Partial<NamespaceStatus> = {}): NamespaceStatus {
  return {
    namespace: "capsid",
    paused: null,
    anchor_pinned: true,
    anchor_problem: null,
    best: { sha: "deadbee", score: 0.82, recorded_at: "2026-09-10T04:00:00Z" },
    last_run: {
      id: "run_1",
      status: "done",
      started: "2026-09-11T08:00:00Z",
      finished: "2026-09-11T08:40:00Z",
      attempts: 3,
      kept: 1,
      reverts: 2,
      cost_usd: 0.42,
      ci_minutes: 12,
      condition: "full",
      pr_url: null,
      note: null,
    },
    totals: { runs: 9, attempts: 20, kept: 6, reverts: 14, cost_usd: 3.2, ci_minutes: 140 },
    latest_report: { path: "capsid/reports/lint-2026-09-10.md", integrity: 97, generated: "2026-09-10 06:00:00" },
    jobs: { queued: 2, claimed: 1, blocked: 0, done_today: 4, blocked_jobs: [] },
    ...overrides,
  };
}

function data(namespaces: NamespaceStatus[], agents: AgentReputation[] = []): ConsoleData {
  return {
    generated: "2026-09-11T14:00:00.000Z",
    viewer: "DrDustinEdwards",
    health: health(),
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
      namespaces,
    },
    agents,
  };
}

test("a row carries the run, the counts, the integrity and the anchor state", () => {
  const html = renderConsole(data([namespaceStatus()]));
  assert.match(html, /capsid/);
  assert.match(html, /anchor pinned/i);
  assert.match(html, /3 attempts/, "the last run's attempt count is missing");
  assert.match(html, /1 kept/, "the last run's kept count is missing");
  assert.match(html, /2 reverted/, "the last run's revert count is missing");
  assert.match(html, /97%/, "the truth report's integrity percentage is missing");
  // The four job counts.
  assert.match(html, /2 queued/);
  assert.match(html, /1 claimed/);
  assert.match(html, /0 blocked/);
  assert.match(html, /4 done today/);
});

test("a paused namespace shows the reason, not just a flag", () => {
  const html = renderConsole(data([namespaceStatus({ paused: "holdout suite rebuilt, resume after review" })]));
  assert.match(html, /paused/i);
  assert.match(html, /holdout suite rebuilt, resume after review/);
});

test("an unpinned anchor is called out rather than shown as a bare false", () => {
  const html = renderConsole(
    data([namespaceStatus({ anchor_pinned: false, anchor_problem: "anchors checksum does not match the pin" })])
  );
  assert.match(html, /anchor NOT pinned/i);
  assert.match(html, /anchors checksum does not match the pin/);
});

test("A BLOCKED JOB IS RENDERED WITH THE EXACT COMMAND IT WAITS ON", () => {
  const command = "git push -u origin feat/console";
  const html = renderConsole(
    data([
      namespaceStatus({
        jobs: {
          queued: 0,
          claimed: 0,
          blocked: 1,
          done_today: 0,
          blocked_jobs: [
            {
              id: "job_9673b301868e",
              title: "Console: one page for state",
              waiting_on: `the push gate.\n\nRun this, then send it back in with jobs action 'resume':\n\n    ${command}`,
              blocked_times: 1,
              resumed: 0,
            },
          ],
        },
      }),
    ])
  );
  assert.match(html, /job_9673b301868e/);
  assert.match(html, /Console: one page for state/);
  assert.match(html, /git push -u origin feat\/console/, "the command a human has to run is missing");
  assert.match(html, /blocked once/i, "how many times this job has hit a gate is missing");
});

test("the blocked job's command is ESCAPED, not injected", () => {
  const html = renderConsole(
    data([
      namespaceStatus({
        jobs: {
          queued: 0,
          claimed: 0,
          blocked: 1,
          done_today: 0,
          blocked_jobs: [
            { id: "job_x", title: "<script>alert(1)</script>", waiting_on: "run <b>this</b>", blocked_times: 1, resumed: 0 },
          ],
        },
      }),
    ])
  );
  assert.doesNotMatch(html, /<script>alert/, "a job title reached the page as markup");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /run <b>this<\/b>/);
});

test("the row names the driver agent's last_seen, matched from the agent inventory", () => {
  const html = renderConsole(
    data(
      [namespaceStatus()],
      [
        {
          name: "capsid-driver",
          kind: "driver",
          namespaces: ["capsid"],
          grants: ["read", "write"],
          flags: [],
          last_seen: "2026-09-11 14:12:01",
          revoked_at: null,
          jobs_completed: 4,
          jobs_failed: 0,
          jobs_blocked: 1,
          prs_opened: 2,
          prs_merged: 0,
          attempts_kept: 6,
          attempts_reverted: 14,
        },
        {
          name: "foxing-driver",
          kind: "driver",
          namespaces: ["foxing"],
          grants: ["read"],
          flags: [],
          last_seen: "2026-09-01 03:00:00",
          revoked_at: null,
          jobs_completed: 0,
          jobs_failed: 0,
          jobs_blocked: 0,
          prs_opened: 0,
          prs_merged: 0,
          attempts_kept: 1,
          attempts_reverted: 3,
        },
      ]
    )
  );
  // Scoped to the namespace SECTION, not the whole page: the agents panel lists every
  // credential and legitimately prints both timestamps, so asserting over the whole
  // document would pass for the wrong reason once that panel exists.
  const row = html.slice(html.indexOf('<section class="ns">'), html.indexOf("</section>"));
  assert.match(row, /driver last seen/i);
  assert.match(row, /2026-09-11 14:12:01/);
  // The OTHER namespace's driver must not be borrowed for this row.
  assert.doesNotMatch(row, /2026-09-01 03:00:00/, "a different namespace's driver last_seen leaked into the row");
});

test("a namespace whose driver has never connected says so instead of showing a blank", () => {
  const html = renderConsole(data([namespaceStatus()], []));
  assert.match(html, /driver last seen/i);
  assert.match(html, /no driver agent/i);
});

test("a namespace that has never run, never scored and never reported renders without throwing", () => {
  const html = renderConsole(
    data([namespaceStatus({ best: null, last_run: null, latest_report: null, anchor_pinned: false, anchor_problem: null })])
  );
  assert.match(html, /never run/i);
  assert.match(html, /no truth report/i);
  // A namespace with no report is NOT an integrity of zero, and the page must not
  // imply it is.
  assert.doesNotMatch(html, /\b0%/, "a missing truth report was rendered as 0%");
});
