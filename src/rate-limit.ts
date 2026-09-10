export interface RateLimitPolicy {
  // Distinct per endpoint so one path cannot spend another's budget.
  prefix: string;
  perHour: number;
  perDay: number;
  label: string;
}

export const MAX_PER_HOUR = 30;
export const MAX_PER_DAY = 100;

export const REGISTRATION_LIMIT: RateLimitPolicy = {
  prefix: "dcr:rate:",
  perHour: MAX_PER_HOUR,
  perDay: MAX_PER_DAY,
  label: "DCR",
};

// At most one non-loopback redirect_uri per registered client. Loopback is exempt
// so a native client can cycle ports.
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    // An unparseable URI counts as non-loopback, so a malformed entry cannot slip
    // the cap.
    return false;
  }
}

export interface DcrRefusal {
  code: string;
  status: number;
  description: string;
}

export function dcrRedirectRefusal(clientMetadata: unknown): DcrRefusal | null {
  const raw = (clientMetadata as { redirect_uris?: unknown } | null | undefined)?.redirect_uris;
  const uris = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string") : [];
  const nonLoopback = uris.filter((u) => !isLoopbackRedirect(u));
  if (nonLoopback.length > 1) {
    return {
      code: "invalid_redirect_uri",
      status: 400,
      description: `A client may register at most one non-loopback redirect_uri; this one declared ${nonLoopback.length}. Register a single redirect, or use loopback addresses for a native client.`,
    };
  }
  return null;
}

export const MAX_REPORTS_PER_HOUR = 300;
export const MAX_REPORTS_PER_DAY = 1000;

export const CSP_REPORT_LIMIT: RateLimitPolicy = {
  prefix: "csp:rate:",
  perHour: MAX_REPORTS_PER_HOUR,
  perDay: MAX_REPORTS_PER_DAY,
  label: "CSP_REPORT",
};

export type RateVerdict =
  | { allowed: true }
  | { allowed: false; window: "hour" | "day"; count: number; limit: number };

function windowKeys(prefix: string, ip: string, now: Date): { hour: string; day: string } {
  const iso = now.toISOString();
  return { hour: `${prefix}h:${ip}:${iso.slice(0, 13)}`, day: `${prefix}d:${ip}:${iso.slice(0, 10)}` };
}

// Fails open: a KV outage must not lock the owner out of reconnecting.
export async function checkRate(
  kv: KVNamespace | undefined,
  ip: string,
  now: Date,
  policy: RateLimitPolicy
): Promise<RateVerdict> {
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

  // Refuse before the write, or retrying extends the block.
  if (hourCount >= policy.perHour) return { allowed: false, window: "hour", count: hourCount, limit: policy.perHour };
  if (dayCount >= policy.perDay) return { allowed: false, window: "day", count: dayCount, limit: policy.perDay };

  try {
    await Promise.all([
      kv.put(keys.hour, String(hourCount + 1), { expirationTtl: 3600 }),
      kv.put(keys.day, String(dayCount + 1), { expirationTtl: 86_400 }),
    ]);
  } catch (err) {
    console.error(`${policy.label}_RATE_LIMIT_UNAVAILABLE write failed for ${ip}, allowing: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { allowed: true };
}

export async function checkRegistrationRate(kv: KVNamespace, ip: string, now: Date): Promise<RateVerdict> {
  return checkRate(kv, ip, now, REGISTRATION_LIMIT);
}

export async function checkCspReportRate(kv: KVNamespace | undefined, ip: string, now: Date): Promise<RateVerdict> {
  return checkRate(kv, ip, now, CSP_REPORT_LIMIT);
}

export function callerIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// 429, not 204: a dropped report must not look stored.
export function rateLimitedResponse(verdict: Extract<RateVerdict, { allowed: false }>): Response {
  return new Response(`too many reports: ${verdict.count} in the last ${verdict.window}, limit ${verdict.limit}`, {
    status: 429,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Retry-After": verdict.window === "hour" ? "3600" : "86400",
    },
  });
}
