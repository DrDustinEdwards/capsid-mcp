import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APPROVAL_MAX_AGE_SECONDS, approvalTag } from "../src/approval.ts";
import { callerIp, checkRegistrationRate, MAX_PER_DAY, MAX_PER_HOUR, type RateVerdict } from "../src/rate-limit.ts";
import { fakeKv } from "./fakes.ts";

const src = (name: string) => readFileSync(join(import.meta.dirname, "..", "src", name), "utf8");

// The KV is the shared fake now (quality audit 6.2). Its failure injection came
// from this file's local copy and is what makes the limiter's fail-open paths
// testable at all; the merged version keeps it and adds list plus pagination.

const NOW = new Date("2026-08-17T14:30:00.000Z");
const HOUR_KEY = "dcr:rate:h:1.2.3.4:2026-08-17T14";
const DAY_KEY = "dcr:rate:d:1.2.3.4:2026-08-17";

// ---- 3. the /register rate limit --------------------------------------------

test("a first registration is allowed and both counters start at 1", async () => {
  const kv = fakeKv();
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true });
  assert.equal(kv.store.get(HOUR_KEY), "1");
  assert.equal(kv.store.get(DAY_KEY), "1");
  // The counters must expire, or the daily bucket becomes permanent.
  assert.deepEqual(kv.puts.map((p) => p.ttl).sort((a, b) => (a ?? 0) - (b ?? 0)), [3600, 86_400]);
});

test("the hourly limit refuses at the threshold, named", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_PER_HOUR), [DAY_KEY]: "40" } });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, "hour");
  assert.equal(verdict.limit, MAX_PER_HOUR);
  assert.equal(verdict.count, MAX_PER_HOUR);
  // A refused call must not advance the counter, or a blocked caller stays blocked
  // for longer every time they retry.
  assert.deepEqual(kv.puts, []);
});

test("a refusal cannot be constructed without its reason", () => {
  // COMPILE-TIME, and it is the whole point of the union (quality audit 3.3).
  // RateVerdict was one interface with allowed:boolean and three OPTIONAL fields,
  // so `{ allowed: false }` typechecked, and index.ts interpolates all three into
  // the 429 body: that value renders as "undefined in the last undefined, limit
  // undefined". @ts-expect-error inverts the assertion, failing `npm run
  // check:test` if the line below ever stops being an error, which is what
  // collapsing the union back into optional fields would do.
  // @ts-expect-error a refused verdict must name its window, count and limit
  const broken: RateVerdict = { allowed: false };
  assert.equal(broken.allowed, false);
});

test("the daily limit refuses even when the hour is quiet", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: "1", [DAY_KEY]: String(MAX_PER_DAY) } });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, "day");
  assert.equal(verdict.limit, MAX_PER_DAY);
});

test("the measured 2026-08-09 burst still gets through", async () => {
  // 22 registrations from one IP inside about two hours, which is what claude.ai
  // legitimately did while the consent flow was broken. A limit that blocks this
  // blocks Dustin mid-incident, so it is asserted rather than assumed.
  const kv = fakeKv();
  for (let i = 0; i < 22; i++) {
    const at = new Date(NOW.getTime() + i * 5 * 60_000); // one every 5 minutes
    const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", at);
    assert.equal(verdict.allowed, true, `registration ${i + 1} of 22 was refused`);
  }
  assert.equal(Number(kv.store.get(DAY_KEY)), 22);
});

test("the limiter FAILS OPEN when the counter read throws", async () => {
  const kv = fakeKv({ failGet: true });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true }, "a KV read failure blocked a registration");
});

test("the limiter FAILS OPEN when the counter write throws", async () => {
  const kv = fakeKv({ failPut: true });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true }, "a KV write failure blocked a registration");
});

test("the limiter FAILS OPEN on a corrupt counter value", async () => {
  // Corrupted at the store, not at a key name this test guessed: a change to the
  // key layout must not turn this into a test that passes by reading nothing.
  // The shared fake takes the corrupt VALUE rather than a boolean, so a test can
  // say what kind of corruption it means.
  const kv = fakeKv({ corrupt: "not-a-number" });
  const verdict = await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.deepEqual(verdict, { allowed: true });
});

test("counters are per IP and per window", async () => {
  // The bucket is FILLED by driving the real code, not by seeding a key name this
  // test assumed. A single global bucket would then refuse the second address, and
  // that is the failure this is here to catch.
  const kv = fakeKv();
  for (let i = 0; i < MAX_PER_HOUR; i++) await checkRegistrationRate(kv.kv, "1.2.3.4", NOW);
  assert.equal((await checkRegistrationRate(kv.kv, "1.2.3.4", NOW)).allowed, false, "the bucket did not fill");
  assert.equal((await checkRegistrationRate(kv.kv, "9.9.9.9", NOW)).allowed, true, "one address blocked another");
  // And the next hour is a fresh bucket for the blocked address.
  const nextHour = new Date(NOW.getTime() + 3600_000);
  assert.equal((await checkRegistrationRate(kv.kv, "1.2.3.4", nextHour)).allowed, true, "the hour window never rolls");
});

test("callerIp reads CF-Connecting-IP and falls back off the edge", () => {
  assert.equal(callerIp(new Request("https://x/", { headers: { "CF-Connecting-IP": "5.6.7.8" } })), "5.6.7.8");
  assert.equal(callerIp(new Request("https://x/")), "unknown");
});

test("the rejection is wired to the library's registration callback", () => {
  const index = src("index.ts");
  assert.match(index, /clientRegistrationCallback: async/);
  assert.match(index, /checkRegistrationRate\(env\.APP_KV/);
  assert.match(index, /status: 429/);
  // Fail open at the wiring layer too: no env must not mean no registration.
  assert.match(index, /if \(!env\) \{[\s\S]*?return;/);
});

// ---- 1. F18: the state is consumed after the exchange, not before ------------

test("the state delete follows the GitHub token exchange", () => {
  const handler = src("routes.ts");
  const callback = handler.slice(handler.indexOf("async function handleCallback"));
  const readAt = callback.indexOf("await env.OAUTH_KV.get(stateKey)");
  const exchangeAt = callback.indexOf("await fetch(GITHUB_TOKEN_URL");
  const accessTokenAt = callback.indexOf("if (!tokenData.access_token)");
  const deleteAt = callback.indexOf("await env.OAUTH_KV.delete(stateKey)", accessTokenAt);
  assert.ok(readAt > 0 && exchangeAt > 0 && accessTokenAt > 0, "handleCallback no longer has the shape this asserts");
  assert.ok(deleteAt > accessTokenAt, "the state is still deleted before the exchange succeeds");
  // And nothing deletes it between the read and the exchange.
  const between = callback.slice(readAt, exchangeAt);
  const strayDelete = between.indexOf("OAUTH_KV.delete(stateKey)");
  if (strayDelete !== -1) {
    // The only permitted early delete is the corrupt-payload path, which returns 403.
    assert.match(between.slice(strayDelete, strayDelete + 220), /unreadable/);
  }
});

test("a corrupt stored state answers 403 instead of throwing", () => {
  const handler = src("routes.ts");
  const callback = handler.slice(handler.indexOf("async function handleCallback"));
  // The parse is guarded and the guard returns the restart instruction.
  assert.match(callback, /try \{\s*oauthReq = JSON\.parse\(stored\) as AuthRequest;\s*\} catch \{/);
  assert.match(callback, /"stored authorization state is unreadable\. Restart from your MCP client\.", 403/);
});

// ---- 2. the approval cookie -------------------------------------------------

test("the approval cookie lives 30 days, not a year", () => {
  assert.equal(APPROVAL_MAX_AGE_SECONDS, 2_592_000);
  const handler = src("routes.ts");
  assert.match(handler, /Max-Age=\$\{APPROVAL_MAX_AGE_SECONDS\}/);
  assert.doesNotMatch(handler, /Max-Age=31536000/, "the one year approval cookie is back");
});

test("an approval is bound to the client's redirect set, not the bare id", () => {
  const handler = src("routes.ts");
  // Both sides use the tag: the check and the store.
  assert.match(handler, /approved\.includes\(await approvalTag\(oauthReq\.clientId, client\.redirectUris\)\)/);
  assert.match(handler, /const tag = await approvalTag\(oauthReq\.clientId, client\.redirectUris\);/);
  assert.doesNotMatch(handler, /approved\.includes\(oauthReq\.clientId\)/, "the bare client id check is back");
});

test("the client is resolved before the cookie can skip the dialog", () => {
  // Order matters: a client id that no longer resolves must not ride an old cookie
  // past the consent screen.
  const handler = src("routes.ts");
  const get = handler.slice(handler.indexOf("async function handleAuthorizeGet"), handler.indexOf("async function handleAuthorizePost"));
  const lookupAt = get.indexOf("lookupClient(oauthReq.clientId)");
  const approvedAt = get.indexOf("await approvedClients(");
  assert.ok(lookupAt > 0 && approvedAt > 0);
  assert.ok(lookupAt < approvedAt, "the cookie is still consulted before the client is resolved");
});

// The REAL function, not a copy of it: this is the security property of the cookie.
test("the tag is stable across ordering and changes with the redirect set", async () => {
  const claude = ["https://claude.ai/api/mcp/auth_callback", "http://localhost:1/callback"];
  const a = await approvalTag("abc", claude);
  const b = await approvalTag("abc", [...claude].reverse());
  assert.equal(a, b, "ordering changed the approval");
  const moved = await approvalTag("abc", ["https://evil.example/callback"]);
  assert.notEqual(a, moved, "a re-registered client with new redirects kept the old approval");
  const added = await approvalTag("abc", [...claude, "https://evil.example/callback"]);
  assert.notEqual(a, added, "adding a redirect kept the old approval");
  const otherClient = await approvalTag("xyz", claude);
  assert.notEqual(a, otherClient, "two clients with the same redirects share an approval");
  // The measured shape: 16 char id, dot, 16 hex.
  assert.match(a, /^[A-Za-z0-9_-]+\.[0-9a-f]{16}$/);
  assert.equal(await approvalTag("abc", undefined), await approvalTag("abc", []));
});
