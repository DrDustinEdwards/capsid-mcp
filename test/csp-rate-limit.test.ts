import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CSP_REPORT_LIMIT,
  checkCspReportRate,
  checkRegistrationRate,
  MAX_REPORTS_PER_DAY,
  MAX_REPORTS_PER_HOUR,
  rateLimitedResponse,
} from "../src/rate-limit.ts";
import { fakeKv } from "./fakes.ts";

// AN APP-LEVEL RATE LIMIT ON /csp-report (work queue, corrected 2026-08-17).
//
// The board carried "add a WAF rate limiting rule" for weeks. It was never
// possible: Cloudflare rate limiting rules are a ZONE feature and do not apply to
// *.workers.dev, and capsid deploys with no routes and no custom domain. The
// replacement is here, in the Worker, reusing the limiter /register already had.
//
// /csp-report is the more expensive of the two unauthenticated writes per call,
// because every accepted report becomes an R2 object. The handler already bounded
// content type, body size and shape; nothing bounded arrival rate.
//
// EVERY TEST IS ABOUT ONE OF TWO PROPERTIES: the limit actually fires, and it NEVER
// fires for the wrong reason. The second matters more. The point of this endpoint
// is hearing about violations, so a limiter that turns a KV hiccup into silence has
// destroyed the thing it was added to protect.
//
// WHY THE HANDLER ITSELF IS SOURCE-SCANNED rather than driven: src/routes.ts
// imports the Agents SDK, which pulls in `cloudflare:workers`, and node --test
// cannot load that scheme. Nothing in the suite has ever driven defaultHandler for
// this reason. So the limiter and the response are tested directly, as modules the
// suite can import, and the WIRING between them is asserted against the source.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");

const NOW = new Date("2026-08-17T12:00:00Z");
const IP = "203.0.113.7";
const HOUR_KEY = `${CSP_REPORT_LIMIT.prefix}h:${IP}:2026-08-17T12`;
const DAY_KEY = `${CSP_REPORT_LIMIT.prefix}d:${IP}:2026-08-17`;

test("an ordinary report is allowed, and both windows advance with an expiry", async () => {
  const kv = fakeKv();
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, true);
  assert.equal(kv.store.get(HOUR_KEY), "1");
  assert.equal(kv.store.get(DAY_KEY), "1");
  // Without the TTLs the daily bucket becomes permanent.
  assert.deepEqual(kv.puts.map((p) => p.ttl).sort((a, b) => (a ?? 0) - (b ?? 0)), [3600, 86_400]);
});

test("the hourly limit fires AT the threshold, and the refusal names it", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR), [DAY_KEY]: "5" } });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, false, "the hourly limit did not fire at the threshold");
  assert.equal(verdict.window, "hour");
  assert.equal(verdict.limit, MAX_REPORTS_PER_HOUR);
  assert.equal(verdict.count, MAX_REPORTS_PER_HOUR);
  // A REFUSED CALL MUST NOT ADVANCE THE COUNTER, or a blocked caller extends their
  // own block by retrying and can never get back under the limit.
  assert.deepEqual(kv.puts, [], "a refused report advanced the counter");
  assert.equal(kv.store.get(HOUR_KEY), String(MAX_REPORTS_PER_HOUR));
});

test("one under the threshold still passes", async () => {
  // The other side. A limiter that refused at limit-1 would pass the test above and
  // quietly cost every caller one report.
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR - 1) } });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, true, "the limit fired one call early");
  assert.equal(kv.store.get(HOUR_KEY), String(MAX_REPORTS_PER_HOUR));
});

test("the daily limit fires even when the hour is quiet", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: "1", [DAY_KEY]: String(MAX_REPORTS_PER_DAY) } });
  const verdict = await checkCspReportRate(kv.kv, IP, NOW);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.window, "day");
  assert.equal(verdict.limit, MAX_REPORTS_PER_DAY);
  assert.deepEqual(kv.puts, [], "a refused report advanced the counter");
});

// ---- FAIL OPEN, on every path ----------------------------------------------
//
// The one rule of this module. The thing guarded is hearing about violations, so
// every failure below must let the report through. Each is a separate path with its
// own way of going wrong.

test("fail open: a KV read that throws still allows", async () => {
  const kv = fakeKv({ failGet: true });
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, true, "a KV read failure silenced the endpoint");
});

test("fail open: a KV write that throws still allows", async () => {
  // The counter does not advance, so the ceiling is soft under KV trouble. That is
  // the intended trade: refusing would punish the caller for the store's problem.
  const kv = fakeKv({ failPut: true });
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, true);
});

test("fail open: a non-numeric counter allows WITHOUT writing the corruption back", async () => {
  // Number("banana") is NaN and every comparison with NaN is false, so dropping the
  // finite check ALSO allows the call and a test asserting only `allowed` cannot
  // tell the two apart. A plant proved that.
  //
  // The difference is what happens next. Without the check the limiter falls
  // through to the write and stores String(NaN + 1), which is the literal "NaN",
  // and every later read of that key is non-numeric too: the limit is then disabled
  // for that caller for the rest of the window, silently. With it, the read throws,
  // the limiter fails open on the spot, and NOTHING is written.
  const kv = fakeKv({ corrupt: "banana" });
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, true);
  assert.deepEqual(kv.puts, [], "a corrupt counter was incremented, poisoning the key for the whole window");
});

test("fail open: no KV binding allows, and is REPORTED as a binding problem", async () => {
  // A plant corrected this one. An absent binding is already caught by the read
  // try/catch (reading .get off undefined throws inside it), so removing the
  // explicit guard still allows the call and an assertion on `allowed` alone proves
  // nothing about the guard.
  //
  // What the guard buys is the log line, and on a fail-open path the log is the
  // ONLY output. "no KV binding" names a deploy that is missing APP_KV; the
  // fallback would report it as a read failure quoting a TypeError, which sends
  // whoever reads it looking at KV health instead of at wrangler.jsonc.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    assert.equal((await checkCspReportRate(undefined, IP, NOW)).allowed, true, "a missing KV binding silenced the endpoint");
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, `expected one log line, got: ${errors.join(" | ")}`);
  assert.match(errors[0], /CSP_REPORT_RATE_LIMIT_UNAVAILABLE no KV binding/, `wrong diagnosis: ${errors[0]}`);
  assert.doesNotMatch(errors[0], /read failed/, "a missing binding was reported as a KV read failure");
});

// ---- the two policies do not share a budget --------------------------------

test("csp reports and registrations count in separate buckets", async () => {
  // One prefix per endpoint. Sharing would let CSP traffic exhaust the registration
  // budget, which is the one that locks Dustin out of his own server.
  const kv = fakeKv();
  await checkCspReportRate(kv.kv, IP, NOW);
  await checkRegistrationRate(kv.kv, IP, NOW);
  const keys = [...kv.store.keys()];
  assert.equal(keys.filter((k) => k.startsWith("csp:rate:")).length, 2, `csp keys missing: ${keys.join(", ")}`);
  assert.equal(keys.filter((k) => k.startsWith("dcr:rate:")).length, 2, `dcr keys missing: ${keys.join(", ")}`);
  assert.equal(CSP_REPORT_LIMIT.prefix, "csp:rate:");
});

test("a report from another IP does not spend this one's budget", async () => {
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR) } });
  assert.equal((await checkCspReportRate(kv.kv, "198.51.100.4", NOW)).allowed, true, "the limit is not per caller");
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, false);
});

test("a report in the next hour is not blocked by this hour's count", async () => {
  // Fixed windows keyed by the clock. Without this the block would never lift.
  const kv = fakeKv({ seed: { [HOUR_KEY]: String(MAX_REPORTS_PER_HOUR) } });
  assert.equal((await checkCspReportRate(kv.kv, IP, NOW)).allowed, false);
  assert.equal((await checkCspReportRate(kv.kv, IP, new Date("2026-08-17T13:00:00Z"))).allowed, true);
});

// ---- the refusal a caller actually receives --------------------------------

test("a rate-limited caller gets a 429 with a usable Retry-After, not a 204", async () => {
  // 204 is this endpoint's normal answer and would have been the quiet choice.
  // Browsers ignore both, so the difference is entirely for the caller who is not a
  // browser, and answering "stored" for a dropped report is the unconditional
  // success this codebase keeps removing.
  const hourly = rateLimitedResponse({ allowed: false, window: "hour", count: 300, limit: 300 });
  assert.equal(hourly.status, 429, "a dropped report was reported as accepted");
  assert.equal(hourly.headers.get("Retry-After"), "3600");
  assert.match(await hourly.text(), /too many reports: 300 in the last hour, limit 300/);

  // The Retry-After follows the window that actually fired, or an hourly block
  // tells the caller to come back in a day and a daily block in an hour.
  const daily = rateLimitedResponse({ allowed: false, window: "day", count: 1000, limit: 1000 });
  assert.equal(daily.headers.get("Retry-After"), "86400");
});

// ---- the wiring, which the source is the only witness to -------------------

test("the handler checks the limit BEFORE it reads the body", async () => {
  // Ordering, not decoration: a limited caller must not be able to make the Worker
  // read and parse a 16KB body first, and must not reach the R2 write at all.
  const routes = read("../src/routes.ts");
  const handler = routes.slice(routes.indexOf("async function handleCspReport"), routes.indexOf("export const defaultHandler"));
  const limitAt = handler.indexOf("checkCspReportRate");
  const bodyAt = handler.indexOf("await request.text()");
  const putAt = handler.indexOf("env.MEDIA.put");
  assert.ok(limitAt !== -1, "handleCspReport does not rate limit at all");
  assert.ok(bodyAt !== -1 && putAt !== -1, "the handler no longer reads a body or writes to R2; this scan is stale");
  assert.ok(limitAt < bodyAt, "the body is read before the rate limit is checked");
  assert.ok(limitAt < putAt, "the report is stored before the rate limit is checked");
  // And it RETURNS on a refusal rather than merely logging one.
  assert.match(handler, /if \(!rate\.allowed\) \{[\s\S]{0,200}?return rateLimitedResponse\(rate\);/);
});

test("the csp thresholds are the measured ones, and clear of real volume", async () => {
  // 47 reports exist in R2 across the endpoint's whole life (2026-08-12 to
  // 2026-08-15), busiest day 15. The hourly bound is set from what must not break,
  // a CSP debugging session, NOT from that traffic, and it lands 20x the busiest
  // DAY per HOUR. If someone later tunes these toward the measured volume, this is
  // the note that says the two are not the same question.
  assert.equal(MAX_REPORTS_PER_HOUR, 300);
  assert.equal(MAX_REPORTS_PER_DAY, 1000);
  assert.ok(MAX_REPORTS_PER_HOUR > 15 * 15, "the hourly bound is no longer clear of the busiest measured day");
  assert.ok(MAX_REPORTS_PER_DAY > MAX_REPORTS_PER_HOUR, "the daily bound must allow more than a single hour");
});
