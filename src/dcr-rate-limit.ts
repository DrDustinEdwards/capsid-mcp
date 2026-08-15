// An application-level rate limit on dynamic client registration (audit 2, F3,
// code half; the WAF half is a dashboard task and is not this).
//
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

const PREFIX = "dcr:rate:";

export interface RateVerdict {
  allowed: boolean;
  // Null when allowed, or when the check could not run. Names which window fired.
  window?: "hour" | "day";
  count?: number;
  limit?: number;
}

// Fixed windows keyed by the clock, not a sliding log. Two reads and two writes per
// registration, and no cursor to maintain. The cost is the usual fixed-window edge:
// a burst straddling a boundary can pass up to 2x the limit in a short span. For an
// abuse ceiling on a single-user server that is fine, and it is stated rather than
// discovered later.
function windowKeys(ip: string, now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  return { hour: `${PREFIX}h:${ip}:${iso.slice(0, 13)}`, day: `${PREFIX}d:${ip}:${iso.slice(0, 10)}` };
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
export async function checkRegistrationRate(kv: KVNamespace, ip: string, now: Date): Promise<RateVerdict> {
  const keys = windowKeys(ip, now);
  let hourCount: number;
  let dayCount: number;
  try {
    const [h, d] = await Promise.all([kv.get(keys.hour), kv.get(keys.day)]);
    hourCount = Number(h ?? 0);
    dayCount = Number(d ?? 0);
    if (!Number.isFinite(hourCount) || !Number.isFinite(dayCount)) throw new Error("non-numeric counter");
  } catch (err) {
    console.error(`DCR_RATE_LIMIT_UNAVAILABLE read failed for ${ip}, allowing: ${err instanceof Error ? err.message : String(err)}`);
    return { allowed: true };
  }

  if (hourCount >= MAX_PER_HOUR) return { allowed: false, window: "hour", count: hourCount, limit: MAX_PER_HOUR };
  if (dayCount >= MAX_PER_DAY) return { allowed: false, window: "day", count: dayCount, limit: MAX_PER_DAY };

  try {
    await Promise.all([
      kv.put(keys.hour, String(hourCount + 1), { expirationTtl: 3600 }),
      kv.put(keys.day, String(dayCount + 1), { expirationTtl: 86_400 }),
    ]);
  } catch (err) {
    // The counter did not advance. Allow the registration anyway: refusing here
    // would punish the caller for the store's problem.
    console.error(`DCR_RATE_LIMIT_UNAVAILABLE write failed for ${ip}, allowing: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { allowed: true };
}

// The client IP as Cloudflare sees it. Absent only off the edge (local dev), where
// one shared bucket is the right answer rather than a per-caller one.
export function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
