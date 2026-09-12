import type { Env } from "./env";
import { healthReport, type HealthReport } from "./health";
import { escapeHtml } from "./html";
import { improveStatus, type NamespaceStatus, type StatusReport } from "./improve-run";
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_SESSION_TTL_SECONDS,
  readConsoleSession,
  startConsoleLogin,
  type ConsoleUser,
} from "./console-auth";
import { loadReputation, type AgentReputation } from "./console-reputation";
import { activityFilterFrom, loadActivity, ACTIVITY_LIMIT, type ActivityFilter, type ActivityRow } from "./console-activity";

// THE CONSOLE: one page that answers "what is the state of every namespace" without
// asking a chat.
//
// READ-MOSTLY BY DESIGN. It renders what improve_status and jobs already compute and
// offers a short list of control actions over them. It NEVER merges a pull request
// and NEVER mints a credential: a merge can trigger a CI deploy in two of these
// repos, and a mint hands out a key, so both stay where they are (manage_pr and the
// agents tool), behind a caller that had to be given the scope for them.
//
// NO SECOND QUERY PATH. Every number here comes from the same function the MCP tool
// calls. The whole point of the page is to agree with the tool, and a page with its
// own SELECT is a page that can disagree with the thing it is reporting on.

export const CONSOLE_PATH = "/console";
export const CONSOLE_JSON_PATH = "/console.json";
export const CONSOLE_CALLBACK_PATH = "/console/callback";

// AS STRICT AS /authorize, plus one directive that page cannot carry. Everything is
// denied by default, the only relaxation is the inline <style> the page ships with,
// and `form-action 'self'` is safe HERE because a console form posts back to this
// origin and gets a redirect to this origin: no hop leaves. The consent dialog has to
// omit form-action because approving it starts a four hop chain that ends at a
// dynamically registered client redirect_uri, which no static list can name.
export const CONSOLE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export interface ConsoleData {
  generated: string;
  viewer: string;
  health: HealthReport;
  improve: StatusReport;
  agents: AgentReputation[];
  activity: ActivityRow[];
  activity_filter: ActivityFilter;
}

export async function consoleData(
  env: Env,
  viewer: string,
  now: Date,
  filter: ActivityFilter = { namespace: null, actor: null }
): Promise<ConsoleData> {
  const improve = await improveStatus(env);
  return {
    generated: now.toISOString(),
    viewer,
    health: await healthReport(env),
    improve,
    // The inventory improve_status already resolved, with what each credential did
    // counted against it. Passed in rather than re-read, so the panel cannot list an
    // agent the rest of the page does not.
    agents: await loadReputation(env.DB, improve.agents),
    activity: await loadActivity(env.DB, filter),
    activity_filter: filter,
  };
}

// ---- the gate ----------------------------------------------------------------

// A BEARER TOKEN IS REFUSED, NOT REDIRECTED. An agent key or an operator key
// presented to /console is a caller that cannot follow a login redirect and must not
// be treated as an anonymous browser: answering 302 would send a machine to GitHub
// and look, from its side, like the console being unavailable. The refusal names what
// was presented and what the page admits instead.
const BEARER_REFUSAL =
  "forbidden: /console admits the GitHub admin session only. An operator key or an agent key authenticates to /ops/mcp, not to this page; the same state is served by the improve_status and jobs tools there. Open /console in a browser to sign in as the administrator.";

export type ConsoleGate = { ok: true; user: ConsoleUser } | { ok: false; response: Response };

export async function consoleGate(request: Request, env: Env, now: Date, returnTo: string): Promise<ConsoleGate> {
  if (request.headers.get("Authorization")) {
    return {
      ok: false,
      response: new Response(BEARER_REFUSAL, { status: 403, headers: { "Content-Type": "text/plain;charset=utf-8" } }),
    };
  }
  const user = await readConsoleSession(request, env, now);
  if (!user) return { ok: false, response: await startConsoleLogin(request, env, returnTo) };
  return { ok: true, user };
}

export async function handleConsole(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await consoleGate(request, env, now, CONSOLE_PATH);
  if (!gate.ok) return gate.response;
  const data = await consoleData(env, gate.user.login, now, activityFilterFrom(new URL(request.url)));
  // A FRESH TOKEN PER RENDER, set as a cookie and embedded in every form on the page.
  // Double submit: the action handler compares the two with a constant-time compare,
  // and a cross-site POST can carry neither.
  const csrf = crypto.randomUUID();
  return new Response(renderConsole(data, csrf), {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Content-Security-Policy": CONSOLE_CSP,
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Set-Cookie": `${CONSOLE_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=${CONSOLE_SESSION_TTL_SECONDS}`,
    },
  });
}

export async function handleConsoleJson(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await consoleGate(request, env, now, CONSOLE_JSON_PATH);
  if (!gate.ok) return gate.response;
  return Response.json(await consoleData(env, gate.user.login, now, activityFilterFrom(new URL(request.url))));
}

// ---- rendering ---------------------------------------------------------------

const STYLE = `
:root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1a1a1a; --muted: #5a5a5a; --line: #dcdcd8; --card: #fff; --warn: #8a4b00; --bad: #9b1c1c; --good: #1a7f37; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #14161a; --fg: #e8e8e6; --muted: #9a9a96; --line: #2c2f36; --card: #1b1e24; --warn: #e0a458; --bad: #f08a8a; --good: #6cc487; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 70rem; margin: 0 auto; }
h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
h2 { font-size: 1rem; margin: 2rem 0 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.sub { color: var(--muted); margin: 0 0 1.5rem; font-size: 0.875rem; }
.facts { display: flex; flex-wrap: wrap; gap: 0.75rem; padding: 0; margin: 0 0 1rem; list-style: none; }
.facts li { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 0.5rem 0.75rem; }
.facts .k { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.facts .v { font-variant-numeric: tabular-nums; }
.ns { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; }
.ns h3 { margin: 0 0 0.5rem; font-size: 1rem; }
.warn { color: var(--warn); }
.bad { color: var(--bad); }
.good { color: var(--good); }
code { font-family: ui-monospace, monospace; font-size: 0.85em; word-break: break-all; }
.empty { color: var(--muted); font-style: italic; }
.muted { color: var(--muted); }
h4 { font-size: 0.8rem; margin: 1rem 0 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.blocked-list { list-style: none; padding: 0; margin: 0; }
.blocked { border-left: 3px solid var(--warn); padding: 0.25rem 0 0.25rem 0.75rem; margin-bottom: 0.75rem; }
.blocked strong { display: block; }
.acts { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
.act { display: flex; gap: 0.35rem; align-items: center; margin: 0; }
button { font: inherit; font-size: 0.8rem; padding: 0.3rem 0.7rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
input[type="text"] { font: inherit; font-size: 0.8rem; padding: 0.28rem 0.5rem; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); min-width: 12rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
tbody tr:last-child td { border-bottom: 0; }
.num { font-variant-numeric: tabular-nums; }
.revoked td { opacity: 0.55; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 0.6rem; overflow-x: auto; white-space: pre-wrap; font-size: 0.8rem; margin: 0.5rem 0 0; }
`;

function fact(key: string, value: string, cls = ""): string {
  return `<li><span class="k">${escapeHtml(key)}</span><span class="v ${cls}">${escapeHtml(value)}</span></li>`;
}

function backupFact(health: HealthReport): string {
  const { age_hours, warning } = health.backup;
  if (age_hours === null) return fact("backup age", warning ?? "never", "bad");
  return fact("backup age", `${age_hours}h`, warning ? "warn" : "good");
}

function headerFacts(data: ConsoleData): string {
  const { health, improve } = data;
  const b = improve.budget;
  return [
    fact("sha", health.dirty ? `${health.sha} (dirty)` : health.sha, health.dirty ? "warn" : ""),
    fact("store", `${health.store.d1} / ${health.store.fts}`, health.status === "ok" ? "good" : "bad"),
    fact("schema version", health.schema_version ?? "unknown"),
    backupFact(health),
    fact("improve mode", improve.mode, improve.mode === "off" ? "warn" : "good"),
    fact(
      "budget: ci minutes",
      `${b.spend.ci_minutes} of ${b.caps.actions_minutes_month}`,
      b.exceeded ? "bad" : ""
    ),
    fact("budget: model usd", `${b.spend.cost_usd.toFixed(2)} of ${b.caps.model_usd_month}`, b.exceeded ? "bad" : ""),
  ].join("");
}

// THE DRIVER FOR A NAMESPACE IS `<ns>-driver`, resolved out of the inventory
// improve_status already returns rather than queried again. Matched on the exact
// name: a prefix match would let foxing-driver answer for foxing-legacy, and the
// last_seen a person reads off this row is how they decide whether a namespace has
// a driver that still connects.
function driverFor(data: ConsoleData, namespace: string) {
  return data.agents.find((a) => a.name === `${namespace}-driver`) ?? null;
}

function blockedJob(job: NamespaceStatus["jobs"]["blocked_jobs"][number], csrf: string): string {
  const times = job.blocked_times === 1 ? "blocked once" : `blocked ${job.blocked_times} times`;
  const resumed = job.resumed > 0 ? `, resumed ${job.resumed}` : "";
  // The summary is rendered in a <pre> because block() writes the command into it on
  // its own indented line, and a command a human has to retype is a command that gets
  // retyped wrong. Escaped, like everything else that came out of the database.
  const waiting = job.waiting_on
    ? `<pre>${escapeHtml(job.waiting_on)}</pre>`
    : `<p class="empty">This job recorded no command. Read the job document for what it was doing.</p>`;
  return `<li class="blocked">
<strong>${escapeHtml(job.title)}</strong>
<span class="muted"><code>${escapeHtml(job.id)}</code> ${escapeHtml(times)}${escapeHtml(resumed)}</span>
${waiting}
<div class="acts">
${form(csrf, "resume_job", { id: job.id }, "Resume", reasonField("what you approved"))}
${form(csrf, "fail_job", { id: job.id }, "Mark failed", reasonField("why it cannot be done"))}
</div>
</li>`;
}

function namespaceRow(data: ConsoleData, ns: NamespaceStatus, csrf: string): string {
  const driver = driverFor(data, ns.namespace);
  const run = ns.last_run;
  const facts: string[] = [];

  facts.push(
    ns.anchor_pinned
      ? fact("anchor", "anchor pinned", "good")
      : fact("anchor", `anchor NOT pinned${ns.anchor_problem ? "" : " (no problem reported)"}`, "bad")
  );
  facts.push(
    run
      ? fact("last run", `${run.attempts} attempts, ${run.kept} kept, ${run.reverts} reverted (${run.status})`)
      : fact("last run", "never run", "warn")
  );
  facts.push(ns.best ? fact("best", `${ns.best.score} at ${ns.best.sha}`) : fact("best", "no scored commit yet"));
  facts.push(
    ns.latest_report && ns.latest_report.integrity !== null
      ? fact("integrity", `${ns.latest_report.integrity}%`)
      : // A namespace with no report is NOT an integrity of zero, and rendering it as a
        // number would make "never measured" and "measured badly" look the same.
        fact("integrity", "no truth report", "warn")
  );
  facts.push(
    fact(
      "jobs",
      `${ns.jobs.queued} queued, ${ns.jobs.claimed} claimed, ${ns.jobs.blocked} blocked, ${ns.jobs.done_today} done today`,
      ns.jobs.blocked > 0 ? "warn" : ""
    )
  );
  facts.push(
    driver
      ? fact("driver last seen", driver.last_seen ?? "never connected", driver.last_seen ? "" : "warn")
      : fact("driver last seen", `no driver agent named ${ns.namespace}-driver`, "warn")
  );

  const paused = ns.paused
    ? `<p class="bad"><strong>Paused:</strong> ${escapeHtml(ns.paused)}</p>`
    : "";
  const anchorProblem = ns.anchor_problem
    ? `<p class="bad"><strong>Anchor problem:</strong> ${escapeHtml(ns.anchor_problem)}</p>`
    : "";
  const blocked = ns.jobs.blocked_jobs.length
    ? `<h4>Blocked jobs, and what each waits on</h4><ul class="blocked-list">${ns.jobs.blocked_jobs.map((j) => blockedJob(j, csrf)).join("")}</ul>`
    : "";

  // THE SKILLS PANEL. Three numbers and a gap, because the gap is the one a reader
  // cannot compute from the others: a skill offered often and used rarely is a trigger
  // condition that does not describe the work, not a failing skill.
  const s = ns.skills;
  const total = s.candidate + s.live + s.retired;
  const skills =
    total === 0 && s.offered === 0
      ? `<p class="quiet">No skills recorded for this namespace yet.</p>`
      : `<ul class="facts">${[
          fact("skills", `${s.candidate} candidate, ${s.live} live, ${s.retired} retired`),
          s.use_rate === null
            ? fact("use rate", "nothing offered yet", "warn")
            : fact(
                "use rate",
                `${s.used} used of ${s.offered} offered (${Math.round(s.use_rate * 100)} percent)`,
                s.use_rate >= 0.5 ? "good" : "warn"
              ),
          s.last_evaluation
            ? fact("last evaluation", escapeHtml(s.last_evaluation))
            : fact("last evaluation", "never evaluated", "warn"),
        ].join("")}</ul>`;

  return `<section class="ns">
<h3>${escapeHtml(ns.namespace)}</h3>
${paused}${anchorProblem}
<ul class="facts">${facts.join("")}</ul>
<div class="acts">
${
    ns.paused
      ? form(csrf, "unpause", { namespace: ns.namespace }, "Unpause")
      : form(csrf, "pause", { namespace: ns.namespace }, "Pause", reasonField("why"))
  }
</div>
${blocked}
<h4>Skills</h4>
${skills}
</section>`;
}

// EVERY FORM CARRIES THE SAME TWO HIDDEN FIELDS: the action and the CSRF token. The
// confirm is NOT among them, deliberately. Posting without it renders the
// confirmation page, which is what makes the confirm a decision rather than a field
// the browser fills in on the reader's behalf.
function form(csrf: string, action: string, fields: Record<string, string>, label: string, extra = ""): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return `<form method="post" action="${CONSOLE_PATH}" class="act">
<input type="hidden" name="action" value="${escapeHtml(action)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
${hidden}${extra}
<button type="submit">${escapeHtml(label)}</button>
</form>`;
}

function reasonField(placeholder: string): string {
  return `<input type="text" name="reason" placeholder="${escapeHtml(placeholder)}" maxlength="1000">`;
}

function modeForms(data: ConsoleData, csrf: string): string {
  const modes = ["off", "subscription", "api"].filter((m) => m !== data.improve.mode);
  return `<div class="acts">${modes.map((m) => form(csrf, "mode", { value: m }, `Set mode: ${m}`)).join("")}</div>`;
}

// A RATE AS A PERCENTAGE, or a dash when there is no denominator to divide by.
function pct(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function agentRow(agent: AgentReputation, csrf: string): string {
  const scope = agent.namespaces === "*" ? "every namespace" : agent.namespaces.join(", ");
  const flags = agent.flags.length ? agent.flags.join(", ") : "none";
  const attempts =
    agent.attempts_kept === null
      ? ""
      : `<td class="num">${agent.attempts_kept} kept / ${agent.attempts_reverted} reverted</td>`;
  const state = agent.revoked_at
    ? `<span class="bad">revoked ${escapeHtml(agent.revoked_at)}</span>`
    : escapeHtml(agent.last_seen ?? "never connected");
  // THE VERIFIED COLUMN, and it is deliberately not the same numbers as the one
  // beside it. "PRs opened / merged" counts what this credential DID through this
  // Worker, from audit_log. These three come from job_outcomes and only from the
  // fields the Worker checked against GitHub itself, which is why a driver can show
  // pull requests in one column and a dash in this one: it opened them without
  // naming them as evidence on a job.
  //
  // A DASH IS NOT A ZERO. A rate with no denominator is null and reads as "-",
  // because 0% would sort an agent that has done nothing below one that has done
  // something imperfectly.
  const verified = `${pct(agent.record.pr_merge_rate)} / ${pct(agent.record.ci_green_rate)} / ${
    agent.record.median_duration_minutes === null ? "-" : `${agent.record.median_duration_minutes}m`
  }`;
  return `<tr${agent.revoked_at ? ' class="revoked"' : ""}>
<td><code>${escapeHtml(agent.name)}</code></td>
<td>${escapeHtml(agent.kind)}</td>
<td>${escapeHtml(scope)}</td>
<td>${escapeHtml(flags)}</td>
<td>${state}</td>
<td class="num">${agent.jobs_completed} / ${agent.jobs_failed} / ${agent.jobs_blocked}</td>
<td class="num">${agent.prs_opened} / ${agent.prs_merged}</td>
<td class="num">${verified}</td>
${attempts || '<td class="num muted">n/a</td>'}
<td>${agent.revoked_at ? "" : form(csrf, "revoke_agent", { name: agent.name }, "Revoke")}</td>
</tr>`;
}

function agentsPanel(data: ConsoleData, csrf: string): string {
  if (!data.agents.length) return `<p class="empty">No agents have been minted.</p>`;
  return `<p class="sub">Counts and rates, not scores. Every number is a row this store wrote; the verified column is only what this Worker checked against GitHub itself, and a dash means there was nothing to divide by.</p>
<div class="scroll"><table>
<thead><tr>
<th>agent</th><th>kind</th><th>namespaces</th><th>flags held</th><th>last seen</th>
<th>jobs done / failed / blocked</th><th>PRs opened / merged</th>
<th>verified: merge rate / CI green / median</th><th>attempts</th><th></th>
</tr></thead>
<tbody>${data.agents.map((a) => agentRow(a, csrf)).join("")}</tbody>
</table></div>`;
}

function activityPanel(data: ConsoleData): string {
  const f = data.activity_filter;
  // A GET form, so a filtered view is a URL somebody can keep. No CSRF on it, because
  // it reads and changes nothing; the action forms are the ones that mutate.
  const filterForm = `<form method="get" action="${CONSOLE_PATH}" class="act">
<input type="text" name="namespace" placeholder="namespace" value="${escapeHtml(f.namespace ?? "")}" maxlength="64">
<input type="text" name="actor" placeholder="actor" value="${escapeHtml(f.actor ?? "")}" maxlength="128">
<button type="submit">Filter</button>
</form>`;
  if (!data.activity.length) {
    return `<div class="acts">${filterForm}</div><p class="empty">No audit rows match.</p>`;
  }
  const rows = data.activity
    .map(
      (row) => `<tr>
<td>${escapeHtml(row.at)}</td>
<td><code>${escapeHtml(row.actor ?? "")}</code></td>
<td>${escapeHtml(row.action ?? "")}</td>
<td>${escapeHtml(row.namespace ?? "")}</td>
<td><code>${escapeHtml(row.path ?? "")}</code></td>
</tr>`
    )
    .join("");
  return `<div class="acts">${filterForm}</div>
<div class="scroll"><table>
<thead><tr><th>at</th><th>actor</th><th>action</th><th>namespace</th><th>path or job</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}

export function renderConsole(data: ConsoleData, csrf = ""): string {
  const rows = data.improve.namespaces.map((ns) => namespaceRow(data, ns, csrf));
  const namespaces = rows.length
    ? rows.join("")
    : `<p class="empty">No namespaces on the improve roster.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capsid console</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Capsid console</h1>
<p class="sub">Signed in as ${escapeHtml(data.viewer)}. Generated ${escapeHtml(data.generated)}.</p>
<ul class="facts">${headerFacts(data)}</ul>
${modeForms(data, csrf)}
<h2>Namespaces</h2>
${namespaces}
<h2>Agents</h2>
${agentsPanel(data, csrf)}
<h2>Recent activity</h2>
<p class="sub">The last ${ACTIVITY_LIMIT} audit rows, newest first.</p>
${activityPanel(data)}
</main>
</body>
</html>`;
}
