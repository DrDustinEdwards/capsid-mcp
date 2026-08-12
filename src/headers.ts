// Security headers, applied once at the outermost exit.
//
// WHY ONE PLACE. A grep of src/ finds 13 Response constructions, and that is not
// the enumeration. workers-oauth-provider generates /token, /register and both
// .well-known documents itself, and none of those appear anywhere in this
// repository. A per-handler fix reaches only the handlers we can see and misses
// every response the provider makes, which is the "all but one site" failure
// capsid/conventions.md rules on. The outermost exit is the single point that
// sees all of them, and it is where ed73381 put Cache-Control for the same
// reason.
//
// Measured 2026-08-12 across all 12 reachable surfaces, before this file
// existed:
//   Strict-Transport-Security   absent on 12 of 12
//   Permissions-Policy          absent on 12 of 12
//   X-Content-Type-Options      absent on 11 of 12 (present only on the consent HTML)
//   Referrer-Policy             absent on 11 of 12 (same)
//   X-Frame-Options             absent on 11 of 12 (same)
//   Content-Security-Policy     absent on 11 of 12 (same)
// So the consent page carried 4 of 7 and every JSON surface carried none.
//
// PRESERVE WHAT IS ALREADY THERE. Every header below is set only if absent. That
// keeps the consent dialog's own hand-tuned CSP (whose deliberate lack of
// form-action is a ruling, e7a0dff, not an oversight) and keeps anything the
// provider sets for itself. Same rule as the batch-one Cache-Control change.

export type SurfaceClass = "html" | "json" | "other";

// One year, and scoped to this host and anything under it. Deliberately no
// "preload": that is a submission to a browser-vendor list and is effectively
// irreversible, which is not a commitment to make as a side effect of a header
// sweep.
export const HSTS = "max-age=31536000; includeSubDomains";

// capsid is an MCP server and a single consent form. It uses none of these.
export const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

export const REPORT_PATH = "/csp-report";
export const REPORTING_ENDPOINTS = `csp="${REPORT_PATH}"`;

// ITEM 9, FIRST STAGE. Report-Only, never enforced. Promotion requires a
// demonstrated failing case and Dustin's ruling. That discipline is the whole
// point: 423bbd6 skipped it and broke the consent flow for 26 days.
//
// This policy goes on the NON-HTML classes, which today carry no CSP at all. The
// HTML class already has an enforced policy that was ruled on, so duplicating it
// here in Report-Only would report nothing; the HTML class's first stage is the
// COOP trial below instead.
//
// form-action is deliberately absent here too. It is inert on a JSON response,
// but naming it at all in a policy that could later be promoted is how the last
// outage started.
export const CSP_REPORT_ONLY_NON_HTML =
  `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-uri ${REPORT_PATH}; report-to csp`;

// The seventh HTML header, on trial rather than enforced. COOP: same-origin
// severs window.opener, and if a client hosts the consent page in a popup that
// is a live change to the OAuth flow. Report-Only first, promoted only on
// evidence. Ruled 2026-08-12.
export const COOP_REPORT_ONLY = "same-origin";

export function classifySurface(contentType: string | null): SurfaceClass {
  if (!contentType) return "other";
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) return "html";
  // Covers application/json and the +json suffix family (problem+json,
  // reports+json), which is what the provider and the MCP handler emit.
  if (ct.includes("json")) return "json";
  return "other";
}

export function securityHeadersFor(surface: SurfaceClass): Record<string, string> {
  // Every class, every response. nosniff is the one header that is correct
  // everywhere, and it matters most on the text/plain error bodies: without it a
  // browser may sniff one as HTML. HSTS is the "once at the worker level" half
  // of the ruling, and applying it per class rather than globally would be the
  // same partial-enumeration mistake in miniature.
  const base: Record<string, string> = {
    "Strict-Transport-Security": HSTS,
    "X-Content-Type-Options": "nosniff",
    "Reporting-Endpoints": REPORTING_ENDPOINTS,
  };

  if (surface === "html") {
    return {
      ...base,
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": PERMISSIONS_POLICY,
      "Cross-Origin-Opener-Policy-Report-Only": COOP_REPORT_ONLY,
    };
  }

  // JSON and everything else. The ruling for JSON is nosniff plus no-store;
  // no-store is already guaranteed by withCacheDefault in index.ts, so it is not
  // repeated here. Repeating it would also break /health, which is deliberately
  // exempt from no-store and must stay cacheable.
  return {
    ...base,
    "Content-Security-Policy-Report-Only": CSP_REPORT_ONLY_NON_HTML,
  };
}

export function withSecurityHeaders(response: Response): Response {
  const surface = classifySurface(response.headers.get("Content-Type"));
  const wanted = securityHeadersFor(surface);

  const absent = Object.keys(wanted).filter((k) => !response.headers.has(k));
  if (absent.length === 0) return response;

  // Headers on an already-constructed Response can be immutable, so rebuild.
  const headers = new Headers(response.headers);
  for (const key of absent) headers.set(key, wanted[key]);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
