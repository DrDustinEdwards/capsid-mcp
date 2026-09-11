import type { Env } from "./env";
import { healthReport, type HealthReport } from "./health";
import { escapeHtml } from "./html";
import { improveStatus, type StatusReport } from "./improve-run";
import { readConsoleSession, startConsoleLogin, type ConsoleUser } from "./console-auth";

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
}

export async function consoleData(env: Env, viewer: string, now: Date): Promise<ConsoleData> {
  return {
    generated: now.toISOString(),
    viewer,
    health: await healthReport(env),
    improve: await improveStatus(env),
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

type ConsoleGate = { ok: true; user: ConsoleUser } | { ok: false; response: Response };

async function consoleGate(request: Request, env: Env, now: Date, returnTo: string): Promise<ConsoleGate> {
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
  const data = await consoleData(env, gate.user.login, now);
  return new Response(renderConsole(data), {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Content-Security-Policy": CONSOLE_CSP,
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}

export async function handleConsoleJson(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await consoleGate(request, env, now, CONSOLE_JSON_PATH);
  if (!gate.ok) return gate.response;
  return Response.json(await consoleData(env, gate.user.login, now));
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

export function renderConsole(data: ConsoleData): string {
  const rows = data.improve.namespaces.map((ns) => `<section class="ns"><h3>${escapeHtml(ns.namespace)}</h3></section>`);
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
<h2>Namespaces</h2>
${namespaces}
</main>
</body>
</html>`;
}
