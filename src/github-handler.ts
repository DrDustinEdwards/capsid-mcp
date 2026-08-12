import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { isAdminUser, operatorGrant, operatorIdentity, sha256Hex } from "./auth";
import { runBackup } from "./backup";
import { REPORT_PATH } from "./headers";
import { buildServer, type Env } from "./server";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const APPROVAL_COOKIE = "capsid_approved";
const STATE_COOKIE = "capsid_state";
const CSRF_COOKIE = "capsid_csrf";
const STATE_TTL_SECONDS = 600;
const STATE_KV_PREFIX = "capsid:oauth-state:";

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function approvedClients(request: Request, secret: string): Promise<string[]> {
  const raw = getCookie(request, APPROVAL_COOKIE);
  if (!raw) return [];
  const dot = raw.indexOf(".");
  if (dot === -1) return [];
  const sig = raw.slice(0, dot);
  const payload = raw.slice(dot + 1);
  if (sig !== (await hmacHex(secret, payload))) return [];
  try {
    const parsed = JSON.parse(b64urlDecode(payload));
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function approvalCookie(clientIds: string[], secret: string): Promise<string> {
  const payload = b64urlEncode(JSON.stringify(clientIds));
  const sig = await hmacHex(secret, payload);
  return `${APPROVAL_COOKIE}=${sig}.${payload}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=31536000`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderApprovalDialog(oauthReq: AuthRequest, clientName: string, csrf: string): Response {
  const name = escapeHtml(clientName);
  const redirect = escapeHtml(oauthReq.redirectUri);
  const req = b64urlEncode(JSON.stringify(oauthReq));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
.card { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; }
code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 4px; word-break: break-all; }
button { background: #1a7f37; color: #fff; border: 0; border-radius: 6px; padding: 0.6rem 1.4rem; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<div class="card">
<h1>Capsid access request</h1>
<p><strong>${name}</strong> is asking to connect to this MCP server.</p>
<p>Redirect URI: <code>${redirect}</code></p>
<p>Approving will send you to GitHub to sign in. Only the configured admin account is admitted.</p>
<form method="post" action="/authorize">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="req" value="${req}">
<button type="submit">Approve and continue to GitHub</button>
</form>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      // The dialog has an inline <style> and posts a form back to /authorize.
      // No scripts or images, so lock everything else down.
      //
      // form-action is deliberately absent. Approving submits this form into a
      // four hop redirect chain: POST /authorize, 302 to github.com, 302 back
      // to /callback, 302 out to the client's registered redirect_uri. Chrome
      // enforces form-action against every hop, not just the first, and a
      // blocked hop aborts the navigation silently while that response's
      // Set-Cookie still lands. The terminal hop is a dynamically registered
      // client redirect_uri, and any client may register one via /register, so
      // no static allowlist can be correct here. Adding github.com and
      // claude.ai alongside 'self' was considered and rejected: it works only
      // until the next client registers, then fails this same way again.
      //
      // History: this shipped as "form-action 'self'" in 423bbd6, where the
      // headline was dash normalization, and broke hop two for 26 days. It went
      // undetected because the approvedClients fast path 302s straight out of
      // the GET and never submits a form. Allowing github.com fixed hop two and
      // revealed hop four, measured as a callback_entry carrying a valid code
      // with no callback_fail following it, and the consent page still on
      // screen 3 seconds later.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Set-Cookie": `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=${STATE_TTL_SECONDS}`,
    },
  });
}

async function startGithubFlow(
  request: Request,
  env: Env,
  oauthReq: AuthRequest,
  extraCookies: string[] = []
): Promise<Response> {
  const stateToken = crypto.randomUUID();
  await env.OAUTH_KV.put(`${STATE_KV_PREFIX}${stateToken}`, JSON.stringify(oauthReq), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  const origin = new URL(request.url).origin;
  const target = new URL(GITHUB_AUTHORIZE_URL);
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${origin}/callback`);
  target.searchParams.set("scope", "read:user");
  target.searchParams.set("state", stateToken);
  const headers = new Headers({ Location: target.href });
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE}=${await sha256Hex(stateToken)}; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=${STATE_TTL_SECONDS}`
  );
  for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return textResponse(`invalid authorization request: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
  if (!oauthReq.clientId) return textResponse("invalid authorization request: missing client_id", 400);
  const approved = await approvedClients(request, env.COOKIE_ENCRYPTION_KEY);
  if (approved.includes(oauthReq.clientId)) {
    return startGithubFlow(request, env, oauthReq);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return textResponse("unknown client", 400);
  return renderApprovalDialog(oauthReq, client.clientName ?? oauthReq.clientId, crypto.randomUUID());
}

async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const csrf = form.get("csrf");
  const req = form.get("req");
  if (typeof csrf !== "string" || typeof req !== "string") return textResponse("bad request", 400);
  const csrfCookie = getCookie(request, CSRF_COOKIE);
  if (!csrfCookie || csrfCookie !== csrf) return textResponse("csrf validation failed: restart the flow", 403);
  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(b64urlDecode(req)) as AuthRequest;
  } catch {
    return textResponse("bad request", 400);
  }
  if (!oauthReq.clientId || !(await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId))) {
    return textResponse("unknown client", 400);
  }
  const approved = await approvedClients(request, env.COOKIE_ENCRYPTION_KEY);
  if (!approved.includes(oauthReq.clientId)) approved.push(oauthReq.clientId);
  const cookies = [
    await approvalCookie(approved, env.COOKIE_ENCRYPTION_KEY),
    `${CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0`,
  ];
  return startGithubFlow(request, env, oauthReq, cookies);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) return textResponse("missing code or state", 400);

  const stateCookie = getCookie(request, STATE_COOKIE);
  if (!stateCookie || stateCookie !== (await sha256Hex(stateToken))) {
    return textResponse("state validation failed: this browser did not start the flow. Restart from your MCP client.", 403);
  }
  const stateKey = `${STATE_KV_PREFIX}${stateToken}`;
  const stored = await env.OAUTH_KV.get(stateKey);
  if (!stored) return textResponse("state expired or already used. Restart from your MCP client.", 403);
  await env.OAUTH_KV.delete(stateKey);
  const oauthReq = JSON.parse(stored) as AuthRequest;

  const tokenResp = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });
  if (!tokenResp.ok) return textResponse("github token exchange failed", 502);
  const tokenData = (await tokenResp.json()) as { access_token?: string };
  if (!tokenData.access_token) return textResponse("github token exchange failed: no access token returned", 502);

  const userResp = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "capsid-mcp",
    },
  });
  if (!userResp.ok) return textResponse("failed to fetch github user", 502);
  const user = (await userResp.json()) as { id: number; login: string; name: string | null };

  if (!isAdminUser(env, user)) {
    return textResponse(
      `access denied: capsid is a single-user server and GitHub account "${user.login}" is not its administrator`,
      403
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: oauthReq.scope,
    props: { id: user.id, login: user.login, name: user.name ?? null },
  });

  const headers = new Headers({ Location: redirectTo });
  headers.append("Set-Cookie", `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}

async function handleOperatorMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // "write" keys get the full tool set; "ro:" keys get operator=false, so the
  // per-tool write gate is a live boundary for them.
  const { grant, fingerprint } = await operatorIdentity(request, env);
  if (!grant) {
    return new Response("unauthorized: valid operator key required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  // Which key, not just that a key was valid. Several keys are in use (an agent
  // key, the cron key, a laptop key) and the audit log could not previously tell
  // them apart. The fingerprint is a 12-char prefix of the key's sha256; the
  // full digest is the stored verifier and deliberately stays out of the log.
  return createMcpHandler(buildServer(env, grant === "write", `opkey:${fingerprint}`), { route: "/ops/mcp" })(
    request,
    env,
    ctx
  );
}

async function handleBackup(request: Request, env: Env): Promise<Response> {
  if ((await operatorGrant(request, env)) !== "write") {
    return new Response("unauthorized: write-grant operator key required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  const summary = await runBackup(env);
  return Response.json(summary);
}

// Item 9 report sink. Unauthenticated by necessity: a browser posts a violation
// report with no credentials and will not retry.
//
// R2 IS THE RECORD, THE LOG IS THE CONVENIENCE. Ruled 2026-08-12. Workers
// Observability alone was rejected because its retention is 7 days and that
// ceiling has already bitten once: the 2026-08-10 actor investigation cleared
// only because the window happened to still be open. This surface fails
// sparsely by nature, since the approved-client fast path means the consent form
// rarely renders, which is exactly how a total outage hid for 26 days. A
// promotion ruling for the CSP and COOP trials needs the whole soak record, not
// a rolling week. The console.log is so a live tail still shows a violation the
// moment it lands.
//
// Bounded on purpose: this is a public unauthenticated write path with no rate
// limit in front of it, so an oversized body is refused rather than stored, and
// the key is one object per ray id rather than per report.
const CSP_REPORT_MAX_BYTES = 16384;
const CSP_REPORT_PREFIX = "reports/csp/";

function summarizeReport(parsed: unknown): { directive: string; blocked: string; document: string } {
  // Two wire formats reach here. report-uri sends {"csp-report": {...}} with
  // hyphenated keys; the Reporting API (report-to) sends an array of
  // {type, body} with camelCase keys, and COOP reports arrive that way too.
  const legacy = (parsed as { "csp-report"?: Record<string, unknown> } | null)?.["csp-report"];
  if (legacy) {
    return {
      directive: String(legacy["effective-directive"] ?? legacy["violated-directive"] ?? "?"),
      blocked: String(legacy["blocked-uri"] ?? "?"),
      document: String(legacy["document-uri"] ?? "?"),
    };
  }
  const first = Array.isArray(parsed) ? (parsed[0] as { type?: string; body?: Record<string, unknown> }) : null;
  if (first?.body) {
    return {
      directive: String(first.body.effectiveDirective ?? first.type ?? "?"),
      blocked: String(first.body.blockedURL ?? "?"),
      document: String(first.body.documentURL ?? "?"),
    };
  }
  return { directive: "?", blocked: "?", document: "?" };
}

async function handleCspReport(request: Request, env: Env): Promise<Response> {
  const raw = await request.text();
  if (raw.length > CSP_REPORT_MAX_BYTES) return new Response(null, { status: 413 });

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Keep the raw body rather than dropping it: an unparseable report still
    // says a violation fired, and the shape is worth seeing.
  }

  const now = new Date();
  const ray = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const key = `${CSP_REPORT_PREFIX}${now.toISOString().slice(0, 10)}/${ray}.json`;
  const summary = summarizeReport(parsed);

  console.log(
    JSON.stringify({
      kind: "csp-violation",
      key,
      directive: summary.directive,
      blocked: summary.blocked,
      document: summary.document,
    })
  );

  await env.MEDIA.put(
    key,
    JSON.stringify(
      {
        received_at: now.toISOString(),
        ray,
        content_type: request.headers.get("Content-Type"),
        user_agent: request.headers.get("User-Agent"),
        summary,
        report: parsed ?? raw,
      },
      null,
      2
    ),
    { httpMetadata: { contentType: "application/json" } }
  );

  return new Response(null, { status: 204 });
}

export const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // /health carries deploy provenance so "the deployed worker is this commit"
    // is a readable fact rather than an inference from a clean tree. The vars
    // are stamped at deploy time by scripts/deploy.mjs. dirty=true means the
    // deployed bytes are NOT the named commit.
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        sha: env.BUILD_SHA ?? "unknown",
        dirty: env.BUILD_DIRTY === "true",
        builtAt: env.BUILT_AT ?? null,
      });
    }
    if (url.pathname === REPORT_PATH && request.method === "POST") return handleCspReport(request, env);
    if (url.pathname === "/ops/mcp") return handleOperatorMcp(request, env, ctx);
    if (url.pathname === "/ops/backup" && request.method === "POST") return handleBackup(request, env);
    if (url.pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env);
    if (url.pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    return new Response("not found", { status: 404 });
  },
};
