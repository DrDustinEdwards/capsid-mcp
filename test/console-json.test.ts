import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_JSON_PATH, consoleData, handleConsole, handleConsoleJson, renderConsole } from "../src/console.ts";
import { consoleSessionCookie } from "../src/console-auth.ts";
import { fakeD1, fakeKv } from "./fakes.ts";

// GROUP 6: THE JSON TWIN.
//
// /console.json serves THE SAME OBJECT the page renders, so a dashboard or a chat can
// read the state without scraping HTML. The thing worth guarding is that the two
// cannot drift: if the JSON were assembled separately it would be a second
// description of the same system, and the two would disagree on the day somebody
// changed one of them.
//
// The proof is a deep equality against consoleData itself, called with the same
// arguments. A test that only checked a few fields would pass while the page grew a
// panel the JSON never heard of.

const SECRET = "console-test-cookie-secret";
const NOW = new Date("2026-09-11T14:00:00Z");

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: fakeD1().db,
    APP_KV: fakeKv().kv,
    OAUTH_KV: fakeKv().kv,
    COOKIE_ENCRYPTION_KEY: SECRET,
    ADMIN_GITHUB_LOGIN: "DrDustinEdwards",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    BUILD_SHA: "abc1234",
    ...overrides,
  } as never;
}

async function signedRequest(path = CONSOLE_JSON_PATH): Promise<Request> {
  const cookie = (await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, NOW)).split(";")[0];
  return new Request(`https://capsid.example${path}`, { headers: { Cookie: cookie } });
}

test("console.json IS the page's data source, field for field", async () => {
  const e = env();
  const res = await handleConsoleJson(await signedRequest(), e, NOW);
  assert.equal(res.status, 200);
  const body = await res.json();
  const direct = await consoleData(e, "DrDustinEdwards", NOW, { namespace: null, actor: null });
  assert.deepEqual(body, JSON.parse(JSON.stringify(direct)));
});

test("what the JSON names, the page shows", async () => {
  const e = env();
  const data = await consoleData(e, "DrDustinEdwards", NOW, { namespace: null, actor: null });
  const html = renderConsole(data, "token");
  // Every namespace the JSON carries appears on the page. This is the claim the twin
  // exists to make: reading the JSON tells you what the page would have told you.
  for (const ns of data.improve.namespaces) {
    assert.ok(html.includes(ns.namespace), `${ns.namespace} is in the JSON and not on the page`);
  }
  assert.ok(html.includes(data.health.sha));
  assert.ok(html.includes(data.improve.mode));
});

test("the JSON answers to the same gate as the page: a bearer token is refused", async () => {
  const res = await handleConsoleJson(
    new Request(`https://capsid.example${CONSOLE_JSON_PATH}`, { headers: { Authorization: "Bearer capsid_x" } }),
    env(),
    NOW
  );
  assert.equal(res.status, 403);
});

test("an anonymous reader is sent to sign in, and gets no data", async () => {
  const res = await handleConsoleJson(new Request(`https://capsid.example${CONSOLE_JSON_PATH}`), env(), NOW);
  assert.equal(res.status, 302);
  assert.equal(await res.text(), "");
});

test("the JSON carries no CSRF token", async () => {
  // The token is minted per page render and belongs in a cookie and a form, not in a
  // document any reader of the twin could copy.
  const res = await handleConsoleJson(await signedRequest(), env(), NOW);
  const text = await res.text();
  assert.doesNotMatch(text, /csrf/i);
});

test("the JSON honours the activity filter the query string asked for", async () => {
  const e = env();
  const cookie = (await consoleSessionCookie({ login: "DrDustinEdwards", id: 7 }, SECRET, NOW)).split(";")[0];
  const res = await handleConsoleJson(
    new Request(`https://capsid.example${CONSOLE_JSON_PATH}?namespace=capsid&actor=agent%3Acapsid-driver`, {
      headers: { Cookie: cookie },
    }),
    e,
    NOW
  );
  const body = (await res.json()) as { activity_filter: { namespace: string | null; actor: string | null } };
  assert.deepEqual(body.activity_filter, { namespace: "capsid", actor: "agent:capsid-driver" });
});

test("the page and the twin agree on the same request, down to the generated stamp", async () => {
  const e = env();
  const page = await handleConsole(await signedRequest("/console"), e, NOW);
  const json = await handleConsoleJson(await signedRequest(), e, NOW);
  const body = (await json.json()) as { generated: string; viewer: string };
  const html = await page.text();
  assert.equal(body.generated, NOW.toISOString());
  assert.ok(html.includes(body.generated), "the page and the twin were generated from different instants");
  assert.ok(html.includes(body.viewer));
});
