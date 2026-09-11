import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_ACTIONS, handleConsoleAction } from "../src/console-actions.ts";
import { consoleSessionCookie } from "../src/console-auth.ts";
import { fakeD1, fakeKv } from "./fakes.ts";

// GROUP 4: THE ACTIONS.
//
// Five controls, and the shape of every one is the same: admin session, CSRF, a
// confirm step that states what is about to happen, then the SHARED mutator that the
// MCP tool already calls, then an audit row naming the human who clicked.
//
// TWO THINGS THE CONSOLE MUST NOT DO, and they are tested as absences rather than
// left to good intentions: it never merges a pull request (a merge can start a CI
// deploy in two of these repos, and manage_pr is where that decision lives behind a
// caller holding can_merge), and it never mints a credential. A page reachable with a
// cookie is the wrong place for either.
//
// THE CONFIRM IS A SECOND REQUEST, not a hidden field. A hidden field the form always
// sends confirms nothing: the browser sends it whether or not a person read the page.
// A first POST renders what will happen and changes nothing; only the second one,
// carrying the same CSRF, performs it.

const SECRET = "console-test-cookie-secret";
const CSRF = "11111111-2222-3333-4444-555555555555";

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: fakeD1().db,
    APP_KV: fakeKv().kv,
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_GITHUB_LOGIN: "DrDustinEdwards",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ...overrides,
  } as never;
}

async function sessionCookie(): Promise<string> {
  const full = await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, new Date());
  return full.split(";")[0];
}

async function post(
  fields: Record<string, string>,
  opts: { csrfCookie?: string | null; session?: boolean; auth?: string } = {}
): Promise<Request> {
  const cookies: string[] = [];
  if (opts.session !== false) cookies.push(await sessionCookie());
  const csrfCookie = opts.csrfCookie === undefined ? CSRF : opts.csrfCookie;
  if (csrfCookie) cookies.push(`capsid_console_csrf=${csrfCookie}`);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (opts.auth) headers.Authorization = opts.auth;
  return new Request("https://capsid.example/console", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

const CONFIRMED = { csrf: CSRF, confirm: "yes" };

test("the action list is exactly the five controls, and names neither merge nor mint", () => {
  assert.deepEqual([...CONSOLE_ACTIONS].sort(), ["fail_job", "mode", "pause", "resume_job", "revoke_agent", "unpause"]);
  for (const forbidden of ["merge", "manage_pr", "mint", "mint_operator_key", "mint_agent"]) {
    assert.ok(!(CONSOLE_ACTIONS as readonly string[]).includes(forbidden), `${forbidden} must not be a console action`);
  }
});

test("a bearer token is refused, on the write path as much as the read path", async () => {
  const e = env();
  const res = await handleConsoleAction(await post({ action: "pause", namespace: "capsid", ...CONFIRMED }, { auth: "Bearer k" }), e);
  assert.equal(res.status, 403);
});

test("no session, no action", async () => {
  const res = await handleConsoleAction(
    await post({ action: "pause", namespace: "capsid", ...CONFIRMED }, { session: false }),
    env()
  );
  // Redirected to sign in, and nothing was written.
  assert.equal(res.status, 302);
});

for (const [action, fields] of [
  ["pause", { namespace: "capsid", reason: "looking at a regression" }],
  ["unpause", { namespace: "capsid" }],
  ["mode", { value: "off" }],
  ["resume_job", { id: "job_1", reason: "ran the push" }],
  ["fail_job", { id: "job_1", reason: "superseded" }],
  ["revoke_agent", { name: "capsid-driver" }],
] as const) {
  test(`${action} REFUSES without a CSRF token, and writes nothing`, async () => {
    const d1 = fakeD1();
    const e = env({ DB: d1.db });
    const res = await handleConsoleAction(
      await post({ action, ...fields, confirm: "yes" }, { csrfCookie: CSRF }),
      e
    );
    assert.equal(res.status, 403, `${action} accepted a request with no csrf field`);
    assert.deepEqual(d1.recorded, [], `${action} wrote something despite failing CSRF`);
  });

  test(`${action} REFUSES when the CSRF field does not match the cookie`, async () => {
    const d1 = fakeD1();
    const res = await handleConsoleAction(
      await post({ action, ...fields, csrf: "a-different-token", confirm: "yes" }, { csrfCookie: CSRF }),
      env({ DB: d1.db })
    );
    assert.equal(res.status, 403);
    assert.deepEqual(d1.recorded, []);
  });

  test(`${action} REFUSES when there is no CSRF cookie at all`, async () => {
    const d1 = fakeD1();
    const res = await handleConsoleAction(
      await post({ action, ...fields, ...CONFIRMED }, { csrfCookie: null }),
      env({ DB: d1.db })
    );
    assert.equal(res.status, 403);
    assert.deepEqual(d1.recorded, []);
  });

  test(`${action} without a confirm shows what it would do and changes NOTHING`, async () => {
    const d1 = fakeD1();
    const kv = fakeKv();
    const res = await handleConsoleAction(
      await post({ action, ...fields, csrf: CSRF }),
      env({ DB: d1.db, APP_KV: kv.kv })
    );
    assert.equal(res.status, 200, `${action} did not render a confirmation`);
    const html = await res.text();
    assert.match(html, /confirm/i);
    assert.match(html, new RegExp(action.replace("_", "[ _]")), "the confirmation should name the action");
    assert.deepEqual(d1.recorded, [], `${action} mutated on the confirmation step`);
    assert.deepEqual(kv.puts, [], `${action} wrote to KV on the confirmation step`);
    // The confirmation carries the CSRF forward, or the second POST cannot succeed.
    assert.match(html, new RegExp(CSRF));
  });
}

test("an unknown action is refused rather than guessed at", async () => {
  const d1 = fakeD1();
  const res = await handleConsoleAction(
    await post({ action: "merge_pr", number: "12", ...CONFIRMED }),
    env({ DB: d1.db })
  );
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /merge_pr/);
  assert.deepEqual(d1.recorded, []);
});

test("pause writes the KV pause key AND an audit row naming the admin who clicked", async () => {
  const d1 = fakeD1();
  const kv = fakeKv();
  const res = await handleConsoleAction(
    await post({ action: "pause", namespace: "capsid", reason: "holdout rebuild", ...CONFIRMED }),
    env({ DB: d1.db, APP_KV: kv.kv })
  );
  assert.equal(res.status, 303, "a completed action should redirect, so a reload does not repeat it");
  assert.equal(res.headers.get("Location"), "/console");
  assert.ok(
    kv.puts.some((p) => p.key.includes("capsid")),
    `the pause key was not written: ${JSON.stringify(kv.puts)}`
  );
  const audits = d1.recorded.filter((r) => /INSERT INTO audit_log/i.test(r.sql));
  assert.ok(audits.length >= 1, "pause wrote no audit row");
  const consoleRow = audits.find((r) => r.params.some((p) => typeof p === "string" && p.startsWith("console-")));
  assert.ok(consoleRow, `no console audit row: ${JSON.stringify(audits.map((a) => a.params))}`);
  // THE HUMAN IS THE ACTOR. improveControl writes its own row as improve-loop, which
  // records that a pause happened and not who asked for it.
  assert.ok(
    consoleRow.params.includes("github:DrDustinEdwards"),
    `the console audit row does not name the admin: ${JSON.stringify(consoleRow.params)}`
  );
});

test("unpause clears the pause key and audits it", async () => {
  const d1 = fakeD1();
  const kv = fakeKv({ seed: { "improve:paused:capsid": "an old reason" } });
  const res = await handleConsoleAction(
    await post({ action: "unpause", namespace: "capsid", ...CONFIRMED }),
    env({ DB: d1.db, APP_KV: kv.kv })
  );
  assert.equal(res.status, 303);
  assert.ok(kv.deleted.some((k) => k.includes("capsid")), `the pause key was not deleted: ${JSON.stringify(kv.deleted)}`);
  assert.ok(d1.recorded.some((r) => r.params.some((p) => p === "console-unpause")));
});

test("mode sets improve_mode through the same control the tool uses", async () => {
  const d1 = fakeD1();
  const kv = fakeKv();
  const res = await handleConsoleAction(
    await post({ action: "mode", value: "subscription", ...CONFIRMED }),
    env({ DB: d1.db, APP_KV: kv.kv })
  );
  assert.equal(res.status, 303);
  assert.ok(kv.puts.some((p) => p.value === "subscription"), `improve_mode was not set: ${JSON.stringify(kv.puts)}`);
  assert.ok(d1.recorded.some((r) => r.params.some((p) => p === "console-mode")));
});

test("a refused action reports the refusal instead of redirecting as though it worked", async () => {
  const d1 = fakeD1();
  const res = await handleConsoleAction(
    await post({ action: "mode", value: "banana", ...CONFIRMED }),
    env({ DB: d1.db })
  );
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /banana/);
});

test("revoke_agent refuses a name that is not a live agent, and says so", async () => {
  const d1 = fakeD1({ agents: [] });
  const res = await handleConsoleAction(
    await post({ action: "revoke_agent", name: "ghost", ...CONFIRMED }),
    env({ DB: d1.db })
  );
  assert.equal(res.status, 400);
  assert.match(await res.text(), /ghost/);
});

test("revoke_agent revokes a live agent and audits the click as well as the revoke", async () => {
  const d1 = fakeD1({
    agents: [
      {
        id: "ag_1",
        name: "capsid-driver",
        kind: "driver",
        key_hash: "f".repeat(64),
        scopes: JSON.stringify({ namespaces: ["capsid"], repos: "*", tools: "*", grants: ["read"], flags: {} }),
        created_by: "github:DrDustinEdwards",
        created_at: "2026-09-01 00:00:00",
        revoked_at: null,
        last_seen: null,
      },
    ],
  });
  const res = await handleConsoleAction(
    await post({ action: "revoke_agent", name: "capsid-driver", ...CONFIRMED }),
    env({ DB: d1.db })
  );
  assert.equal(res.status, 303);
  assert.ok(d1.recorded.some((r) => r.params.some((p) => p === "agent-revoked")), "the revoke itself was not audited");
  assert.ok(d1.recorded.some((r) => r.params.some((p) => p === "console-revoke_agent")), "the click was not audited");
});
