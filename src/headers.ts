export type SurfaceClass = "html" | "json" | "other";

// One year, includeSubDomains. No preload: that is a vendor-list submission and
// effectively irreversible.
export const HSTS = "max-age=31536000; includeSubDomains";

export const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()";

export const REPORT_PATH = "/csp-report";
export const REPORTING_ENDPOINTS = `csp="${REPORT_PATH}"`;
// Intake and prune must agree; this was two literals, one in backup.ts and one in routes.ts.
export const REPORT_PREFIX = "reports/csp/";

// Report-Only, never enforced. form-action is deliberately absent.
export const CSP_REPORT_ONLY_NON_HTML =
  `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; report-uri ${REPORT_PATH}; report-to csp`;

export const COOP_REPORT_ONLY = "same-origin";

// No Origin passes, same-origin passes, claude.ai passes. Everything else is refused.
const MCP_BROWSER_ORIGINS = new Set(["https://claude.ai"]);

export function mcpOriginProblem(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === new URL(request.url).origin) return null;
  if (MCP_BROWSER_ORIGINS.has(origin)) return null;
  return `forbidden: Origin ${origin} is not allowed on /mcp. This endpoint accepts same-origin requests, https://claude.ai, and clients that send no Origin header.`;
}

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

  // no-store is already applied by withCacheDefault; repeating it here would
  // break /health, which is exempt and must stay cacheable.
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
