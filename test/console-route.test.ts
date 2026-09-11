import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_CSP, CONSOLE_PATH, consoleData, handleConsole, renderConsole } from "../src/console.ts";
import { consoleSessionCookie } from "../src/console-auth.ts";
import { fakeD1, fakeKv } from "./fakes.ts";

// GROUP 1: THE ROUTE AND THE SHELL.
//
// The console is the one surface a human reads to answer "what is the state of every
// namespace" without asking a chat, so the thing worth guarding first is who may read
// it. Three callers and three different answers: the admin session renders, a browser
// with no session is sent to GitHub, and a BEARER TOKEN IS REFUSED OUTRIGHT rather
// than redirected. That last one is the case the job names and the one a redirect
// would get wrong: an agent key presented to /console must not be answered with a
// login page it cannot follow, and it must not be treated as an anonymous browser.

const SECRET = "console-test-cookie-secret";

function env(overrides: Record<string, unknown> = {}) {
  const kv = fakeKv();
  const oauthKv = fakeKv();
  return {
    DB: fakeD1().db,
    APP_KV: kv.kv,
    OAUTH_KV: oauthKv.kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_GITHUB_LOGIN: "DrDustinEdwards",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    BUILD_SHA: "abc1234",
    ...overrides,
  } as never;
}

function get(headers: Record<string, string> = {}): Request {
  return new Request(`https://capsid.example${CONSOLE_PATH}`, { headers });
}

test("a bearer token is REFUSED with 403, not redirected to a login it cannot follow", async () => {
  const res = await handleConsole(get({ Authorization: "Bearer capsid_deadbeef" }), env());
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /operator key|agent key/i, `the refusal should name what was presented: ${body}`);
  assert.match(body, /admin/i, "the refusal should say what the console does admit");
});

test("an anonymous browser is sent to GitHub to sign in", async () => {
  const res = await handleConsole(get(), env());
  assert.equal(res.status, 302);
  const location = res.headers.get("Location") ?? "";
  assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.match(location, /redirect_uri=[^&]*%2Fconsole%2Fcallback/);
  // The state cookie is what binds the callback to this browser.
  assert.match(res.headers.get("Set-Cookie") ?? "", /HttpOnly/);
});

test("the admin session renders the page, with the strict CSP and no external references", async () => {
  const cookie = await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, new Date());
  const res = await handleConsole(get({ Cookie: cookie.split(";")[0] }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/html;charset=utf-8");
  assert.equal(res.headers.get("Content-Security-Policy"), CONSOLE_CSP);
  const html = await res.text();
  assert.match(html, /<!doctype html>/i);
  // Self-contained: no script tags at all, and nothing fetched from another origin.
  assert.doesNotMatch(html, /<script/i, "the console must carry no scripts");
  assert.doesNotMatch(html, /https?:\/\/(?!capsid\.example)/i, "the console must reference no external origin");
});

test("the CSP is at least as strict as the consent dialog's", () => {
  assert.match(CONSOLE_CSP, /default-src 'none'/);
  assert.match(CONSOLE_CSP, /base-uri 'none'/);
  assert.match(CONSOLE_CSP, /frame-ancestors 'none'/);
  // The console's forms post back to the console and nowhere else, which is the one
  // place it can be STRICTER than /authorize: that page's form starts a four hop
  // redirect chain out to a client, so it cannot name a form-action at all.
  assert.match(CONSOLE_CSP, /form-action 'self'/);
  assert.doesNotMatch(CONSOLE_CSP, /script-src/, "no script source is allowed, not even 'self'");
});

test("the header carries the live sha, the schema version, the backup age, the budget and the mode", async () => {
  const cookie = await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, new Date());
  const res = await handleConsole(get({ Cookie: cookie.split(";")[0] }), env());
  const html = await res.text();
  for (const label of ["sha", "schema", "backup", "budget", "mode"]) {
    assert.match(html.toLowerCase(), new RegExp(label), `the header is missing ${label}`);
  }
  assert.match(html, /abc1234/, "the header should show the deployed sha it was given");
});

test("the page answers to prefers-color-scheme rather than pinning one theme", async () => {
  const cookie = await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, new Date());
  const res = await handleConsole(get({ Cookie: cookie.split(";")[0] }), env());
  const html = await res.text();
  assert.match(html, /prefers-color-scheme: dark/);
});

test("the shell renders with ZERO namespaces rather than throwing on an empty roster", () => {
  const html = renderConsole({
    generated: "2026-09-11T14:00:00.000Z",
    viewer: "DrDustinEdwards",
    health: {
      status: "ok",
      sha: "abc1234",
      dirty: false,
      builtAt: "2026-09-11T13:00:00.000Z",
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
      agents: [],
      namespaces: [],
    },
  });
  assert.match(html, /No namespaces on the improve roster/);
  assert.match(html, /0009_jobs_required_scopes\.sql/);
  assert.match(html, /5h/, "the backup age should render");
});

test("consoleData reads the header numbers through healthReport and improveStatus", async () => {
  const data = await consoleData(env({ BUILD_SHA: "feedface" }), "DrDustinEdwards", new Date("2026-09-11T14:00:00Z"));
  assert.equal(data.viewer, "DrDustinEdwards");
  assert.equal(data.health.sha, "feedface");
  assert.equal(data.generated, "2026-09-11T14:00:00.000Z");
  // The roster, straight from improveStatus rather than a list this module keeps.
  assert.ok(Array.isArray(data.improve.namespaces));
  assert.ok("budget" in data.improve && "mode" in data.improve);
});
