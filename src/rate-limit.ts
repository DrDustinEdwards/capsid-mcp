// Application-level rate limits on the Worker's two unauthenticated write paths.
//
// NAMED dcr-rate-limit.ts UNTIL 2026-08-17, when /csp-report started using it too
// and the name became a lie about two thirds of the file. Same defect as
// github-handler.ts, ruled the same way in the Q4 quality batch: a file named after
// one of its jobs is a file people stop reading when looking for the others.
//
// THERE IS NO WAF HALF, and that correction is why this file grew. The board
// carried "add a WAF rate limiting rule covering /csp-report and /register" for
// weeks. Cloudflare rate limiting rules are a ZONE feature and do not apply to
// *.workers.dev; capsid deploys with no routes and no custom domain, so it has no
// zone and the dashboard control that task named was never reachable for this
// deployment. Edge protection would mean moving capsid to a custom domain, which
// changes its URL and means reconnecting the connector. So the ceiling is here, in
// the Worker, for both paths.
//
// WHAT A POLICY IS. Two fixed windows and a key prefix. Adding an endpoint means
// adding a policy, not a second limiter: the fail-open discipline below is the
// whole value of this module and a copy of it would drift.
export interface RateLimitPolicy {
  // KV key prefix. Distinct per endpoint so one endpoint's traffic cannot spend
  // another's budget, and so a prefix sweep can reason about one of them.
  prefix: string;
  perHour: number;
  perDay: number;
  // Names the endpoint in the log line, since both policies log through one
  // function and "rate limit unavailable" with no subject is not actionable.
  label: string;
}

// /register is an unauthenticated write into KV. Nothing in the Worker bounded how
// many times it could be called; the only ceiling was the library's 1 MiB payload
// cap and the 90 day expiry on what it wrote.
//
// THE THRESHOLDS ARE MEASURED, NOT PICKED. On 2026-08-09, during the OAuth consent
// outage, claude.ai legitimately registered 22 clients from one IP inside about two
// hours, because the connector re-registers on every connect attempt and every
// attempt was failing. A "10 per hour" limit, which is what instinct suggests,
// would have locked Dustin out in the middle of the incident he was debugging. So
// the hourly bound sits above the worst measured legitimate burst with room on top,
// and the daily bound is roughly one such incident per day.
export const MAX_PER_HOUR = 30;
export const MAX_PER_DAY = 100;

export const REGISTRATION_LIMIT: RateLimitPolicy = {
  prefix: "dcr:rate:",
  perHour: MAX_PER_HOUR,
  perDay: MAX_PER_DAY,
  label: "DCR",
};

// /csp-report is the other unauthenticated write, and it is the more expensive one
// per call: every accepted report becomes an R2 OBJECT. The handler already bounds
// content type, body size and shape; nothing bounded arrival rate.
//
// MEASURED 2026-08-17, from the reports already in R2, which is the whole life of
// the endpoint (live since 2026-08-12, 30 day retention, nothing pruned yet):
// 47 reports total, 12 / 15 / 7 / 13 per day, busiest day 15, mean 11.8. The
// largest burst from one source is 3 reports in 593 ms.
//
// AND THE MEASUREMENT DOES NOT ANSWER THE QUESTION, which is worth saying plainly.
// Every one of those 47 is synthetic: the live gate's fixed 637 byte probe, plus
// curl and node verification runs. ZERO real browser violation reports have ever
// arrived, because the policy is Report-Only and nothing violates it in normal use.
// So the store cannot tell me what a legitimate browser burst looks like, and a
// threshold set just above the measured 3 would be fitting a number to test traffic.
//
// The bound comes instead from what this endpoint must not break. A browser fires
// one report per violation on the legacy report-uri path (the Reporting API batches,
// report-uri does not), and the case that matters is someone DEBUGGING a CSP
// problem: load the page, read the violations, tweak, reload. That is exactly the
// /register lesson, where a limit set to instinct would have bitten during the
// incident it was meant to survive. 300 per hour absorbs fifteen reloads of a page
// throwing twenty distinct violations, which is an aggressive debugging session, and
// is still 20x the busiest day ever recorded, per hour. The daily bound allows
// several such hours.
//
// A per-IP ceiling bounds ONE misbehaving or hostile source. It does nothing about
// a distributed flood, which is what the unavailable WAF rule would have covered.
export const MAX_REPORTS_PER_HOUR = 300;
export const MAX_REPORTS_PER_DAY = 1000;

export const CSP_REPORT_LIMIT: RateLimitPolicy = {
  prefix: "csp:rate:",
  perHour: MAX_REPORTS_PER_HOUR,
  perDay: MAX_REPORTS_PER_DAY,
  label: "CSP_REPORT",
};

// A DISCRIMINATED UNION, so a refusal cannot exist without its reason (quality
// audit 3.3).
//
// This was one interface with `allowed: boolean` and three optional fields, which
// meant `{ allowed: false }` typechecked. The only consumer interpolates all three
// into the 429 body, so that value renders as "undefined in the last undefined,
// limit undefined": a refusal that cannot tell the caller what it hit or when to
// retry. Splitting the type makes that shape unconstructible rather than merely
// discouraged, and narrows the fields for the renderer after one `allowed` check.
export type RateVerdict =
  | { allowed: true }
  | { allowed: false; window: "hour" | "day"; count: number; limit: number };

// Fixed windows keyed by the clock, not a sliding log. Two reads and two writes per
// registration, and no cursor to maintain. The cost is the usual fixed-window edge:
// a burst straddling a boundary can pass up to 2x the limit in a short span. For an
// abuse ceiling on a single-user server that is fine, and it is stated rather than
// discovered later.
function windowKeys(prefix: string, ip: string, now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  return { hour: `${prefix}h:${ip}:${iso.slice(0, 13)}`, day: `${prefix}d:${ip}:${iso.slice(0, 10)}` };
}

// FAILS OPEN, DELIBERATELY, AND THIS IS THE ONE RULE OF THIS MODULE.
//
// Everywhere else in this repo a guard that cannot run blocks and names the reason,
// because the thing it guards is a write to the knowledge base. Here the thing
// guarded is Dustin's ability to connect a client AT ALL. A KV read that times out
// during an incident is exactly when he is most likely to be reconnecting, and a
// rate limiter that turns a KV hiccup into "you cannot register" has done far more
// damage than the abuse it was added to bound. So every failure path below allows
// the registration and says so on the log.
//
// KV is also not atomic: two concurrent registrations can both read N and both
// write N+1, so the count can undershoot. That is acceptable for a coarse ceiling
// and is not worth a Durable Object.
export async function checkRate(
  kv: KVNamespace | undefined,
  ip: string,
  now: Date,
  policy: RateLimitPolicy
): Promise<RateVerdict> {
  // An absent binding is a configuration problem, not a reason to refuse the
  // caller. Same rule as every other path here, and it has to be stated because a
  // missing KV would otherwise throw before the try block below could catch it.
  if (!kv) {
    console.error(`${policy.label}_RATE_LIMIT_UNAVAILABLE no KV binding, allowing ${ip}`);
    return { allowed: true };
  }

  const keys = windowKeys(policy.prefix, ip, now);
  let hourCount: number;
  let dayCount: number;
  try {
    const [h, d] = await Promise.all([kv.get(keys.hour), kv.get(keys.day)]);
    hourCount = Number(h ?? 0);
    dayCount = Number(d ?? 0);
    if (!Number.isFinite(hourCount) || !Number.isFinite(dayCount)) throw new Error("non-numeric counter");
  } catch (err) {
    console.error(`${policy.label}_RATE_LIMIT_UNAVAILABLE read failed for ${ip}, allowing: ${err instanceof Error ? err.message : String(err)}`);
    return { allowed: true };
  }

  // REFUSED BEFORE THE WRITE, deliberately. A blocked caller must not advance their
  // own counter, or retrying extends the block and a caller who hits the limit once
  // can never get back under it.
  if (hourCount >= policy.perHour) return { allowed: false, window: "hour", count: hourCount, limit: policy.perHour };
  if (dayCount >= policy.perDay) return { allowed: false, window: "day", count: dayCount, limit: policy.perDay };

  try {
    await Promise.all([
      kv.put(keys.hour, String(hourCount + 1), { expirationTtl: 3600 }),
      kv.put(keys.day, String(dayCount + 1), { expirationTtl: 86_400 }),
    ]);
  } catch (err) {
    // The counter did not advance. Allow the call anyway: refusing here would
    // punish the caller for the store's problem.
    console.error(`${policy.label}_RATE_LIMIT_UNAVAILABLE write failed for ${ip}, allowing: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { allowed: true };
}

// The registration path keeps its own name. Every existing caller and test reads
// through here unchanged, and the wrapper is what makes the generalization a
// refactor rather than a rewrite of a live auth path.
export async function checkRegistrationRate(kv: KVNamespace, ip: string, now: Date): Promise<RateVerdict> {
  return checkRate(kv, ip, now, REGISTRATION_LIMIT);
}

export async function checkCspReportRate(kv: KVNamespace | undefined, ip: string, now: Date): Promise<RateVerdict> {
  return checkRate(kv, ip, now, CSP_REPORT_LIMIT);
}

// The client IP as Cloudflare sees it. Absent only off the edge (local dev), where
// one shared bucket is the right answer rather than a per-caller one.
export function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// THE REFUSAL RESPONSE, here rather than at the call site, so it can be tested.
// src/routes.ts imports the Agents SDK, which pulls in `cloudflare:workers` and
// cannot be loaded by node --test; anything asserted about the response has to live
// in a module the suite can import.
//
// A 429, NOT the 204 /csp-report normally answers with, and the choice is worth
// stating because 204 is tempting. Browsers fire violation reports and forget them:
// they never read the status, never retry, never back off. To the only caller that
// matters, the two are indistinguishable.
//
// 204 loses on the point that outweighs that. It would mean answering "stored" for
// a report that was dropped, and a status that reports success unconditionally is
// the exact defect removed from the reaper, the canary and the bounded reads this
// week. The callers who can act on the difference, a curl probe, the live gate, a
// future monitor, are the ones who actually read it. Retry-After tells them when.
export function rateLimitedResponse(verdict: Extract<RateVerdict, { allowed: false }>): Response {
  return new Response(`too many reports: ${verdict.count} in the last ${verdict.window}, limit ${verdict.limit}`, {
    status: 429,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      // The window this caller is actually inside, not a fixed guess.
      "Retry-After": verdict.window === "hour" ? "3600" : "86400",
    },
  });
}

