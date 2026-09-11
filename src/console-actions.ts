import { adminAgent } from "./agents";
import { revokeAgent } from "./agents-admin";
import { getCookie, timingSafeEqual } from "./auth";
import { CONSOLE_PATH, consoleGate } from "./console";
import { CONSOLE_CSRF_COOKIE } from "./console-auth";
import { escapeHtml } from "./html";
import type { Env } from "./env";
import { improveControl } from "./improve-run";
import { adminFailJob, resumeJob } from "./jobs";
import { readBoundedText } from "./improve-scorer";

// THE CONSOLE'S FIVE CONTROLS.
//
// Every one is the same shape: the admin session, a CSRF token, a confirm step, then
// THE SHARED MUTATOR the MCP tool already calls, then an audit row naming the person
// who clicked. Nothing here reimplements a transition: pause, unpause and mode go
// through improveControl, the two job actions through src/jobs.ts, and the revoke
// through the agents control plane.
//
// WHAT IS NOT HERE, deliberately. No merge: merging can start a CI deploy in two of
// these repos, and that decision belongs to manage_pr behind a caller holding
// can_merge, not to anything reachable with a browser cookie. No mint: a mint hands
// out a key, and the agents tool is admin-only for that reason. Both absences are
// asserted by test/console-actions.test.ts, because an absence nobody checks is one
// that comes back.
//
// THE CONFIRM IS A SECOND REQUEST. A hidden `confirm` field the form always sends
// confirms nothing: the browser sends it whether or not a person read the page. The
// first POST renders what will happen and changes nothing; the second, carrying the
// same CSRF, performs it.

export const CONSOLE_ACTIONS = ["pause", "unpause", "mode", "resume_job", "fail_job", "revoke_agent"] as const;
export type ConsoleAction = (typeof CONSOLE_ACTIONS)[number];

function isConsoleAction(value: string): value is ConsoleAction {
  return (CONSOLE_ACTIONS as readonly string[]).includes(value);
}

// Same cap and same reasoning as the consent form: these bodies are a handful of
// short fields, and the bound is applied at the stream before anything is parsed.
const ACTION_FORM_MAX_BYTES = 65_536;

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

function required(form: URLSearchParams, field: string): string | null {
  const value = form.get(field);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// What each action is about to do, in a sentence a person can check before clicking
// again. This is the whole value of the confirm step, so it names the target rather
// than the action alone.
function describe(action: ConsoleAction, form: URLSearchParams): string {
  const ns = form.get("namespace") ?? "";
  const id = form.get("id") ?? "";
  switch (action) {
    case "pause":
      return `Pause the improve loop for ${ns}. It stays paused until somebody unpauses it: the pause key has no expiry, deliberately.`;
    case "unpause":
      return `Unpause ${ns}. The loop will open a run for it on the next opener.`;
    case "mode":
      return `Set the improve mode to ${form.get("value") ?? ""} for every namespace.`;
    case "resume_job":
      return `Resume blocked job ${id}. THIS TAKES THE LEASE: the job moves to claimed under your own login, so the driver cannot pick it up until you finish it or it expires.`;
    case "fail_job":
      return `Mark job ${id} failed. This is the seat stepping in on a job it does not hold, and it is recorded as such.`;
    case "revoke_agent":
      return `Revoke the agent ${form.get("name") ?? ""}. Its key stops resolving immediately. The row stays, so its audit history still reads, and the name can never be minted again.`;
  }
}

function confirmPage(action: ConsoleAction, form: URLSearchParams, csrf: string): Response {
  const carried = [...form.entries()]
    .filter(([k]) => k !== "confirm" && k !== "csrf")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm ${escapeHtml(action)}</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.6 system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; }
.card { border: 1px solid currentColor; border-radius: 8px; padding: 1.5rem; }
button { font: inherit; padding: 0.5rem 1.2rem; border-radius: 6px; cursor: pointer; }
a { display: inline-block; margin-left: 1rem; }
</style>
</head>
<body>
<div class="card">
<h1>Confirm: ${escapeHtml(action)}</h1>
<p>${escapeHtml(describe(action, form))}</p>
<form method="post" action="${CONSOLE_PATH}">
${carried}
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<input type="hidden" name="confirm" value="yes">
<button type="submit">Yes, do it</button>
<a href="${CONSOLE_PATH}">Cancel</a>
</form>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}

// THE CLICK'S OWN AUDIT ROW. The shared mutators write their own: improveControl
// records a pause as `improve-loop`, which says a pause happened and not who asked
// for it. This row carries the admin's actor, the action, and what was submitted, so
// the log answers "who paused germomics on Tuesday".
async function auditClick(env: Env, actor: string, action: ConsoleAction, namespace: string | null, params: unknown) {
  await env.DB.batch([
    env.DB
      .prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, ?2, ?3, NULL, ?4)")
      .bind(actor, `console-${action}`, namespace, JSON.stringify(params)),
  ]);
}

export async function handleConsoleAction(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await consoleGate(request, env, now, CONSOLE_PATH);
  if (!gate.ok) return gate.response;

  // Bounded at the stream, before the parse, on a path that mutates.
  const bounded = await readBoundedText(request, ACTION_FORM_MAX_BYTES);
  if (!bounded.ok) return new Response(null, { status: 413 });
  const form = new URLSearchParams(bounded.text);

  const action = form.get("action") ?? "";
  if (!isConsoleAction(action)) {
    return textResponse(
      `unknown console action '${action}'. The console does: ${CONSOLE_ACTIONS.join(", ")}. Merging a pull request and minting a credential are deliberately not among them.`,
      400
    );
  }

  // CSRF BEFORE ANYTHING ELSE THAT COULD WRITE, including the confirmation page:
  // rendering a confirm for a forged request would hand an attacker a page that
  // carries a valid token forward.
  const csrfField = form.get("csrf");
  const csrfCookie = getCookie(request, CONSOLE_CSRF_COOKIE);
  if (!csrfField || !csrfCookie || !timingSafeEqual(csrfCookie, csrfField)) {
    return textResponse("csrf validation failed: reload the console and try again.", 403);
  }

  if (form.get("confirm") !== "yes") return confirmPage(action, form, csrfField);

  const actor = `github:${gate.user.login}`;
  const agent = adminAgent(gate.user.login);
  try {
    switch (action) {
      case "pause":
      case "unpause": {
        const namespace = required(form, "namespace");
        if (!namespace) return textResponse(`${action} needs a namespace.`, 400);
        const reason = form.get("reason")?.trim() || undefined;
        const result = await improveControl(env, action, { namespace, reason });
        await auditClick(env, actor, action, namespace, result);
        break;
      }
      case "mode": {
        const value = required(form, "value");
        if (!value) return textResponse("mode needs a value.", 400);
        const result = await improveControl(env, "mode", { value });
        await auditClick(env, actor, action, null, result);
        break;
      }
      case "resume_job":
      case "fail_job": {
        const id = required(form, "id");
        const reason = required(form, "reason");
        if (!id) return textResponse(`${action} needs a job id.`, 400);
        if (!reason) {
          return textResponse(
            action === "resume_job"
              ? "resume needs a reason: what you approved. A job that came back off a gate with no record of who cleared it is a gate that did not happen."
              : "fail needs a reason. A failed job with no reason is one nobody can retry or rule on.",
            400
          );
        }
        const result =
          action === "resume_job"
            ? await resumeJob(env, agent, now, id, reason)
            : await adminFailJob(env, agent, now, id, reason);
        if (!result.ok) return textResponse(result.refusal ?? `${action} was refused.`, 400);
        await auditClick(env, actor, action, result.job?.namespace ?? null, { id, reason });
        break;
      }
      case "revoke_agent": {
        const name = required(form, "name");
        if (!name) return textResponse("revoke_agent needs an agent name.", 400);
        const result = await revokeAgent(env.DB, actor, name);
        if (!result.ok) return textResponse(result.refusal ?? `revoking ${name} was refused.`, 400);
        await auditClick(env, actor, action, null, { name });
        break;
      }
    }
  } catch (err) {
    // improveControl throws on a bad value rather than returning a refusal, and the
    // message it throws already names what was wrong and says nothing changed.
    return textResponse(err instanceof Error ? err.message : String(err), 400);
  }

  // POST then redirect, so a reload does not repeat the action.
  return new Response(null, { status: 303, headers: { Location: CONSOLE_PATH } });
}
