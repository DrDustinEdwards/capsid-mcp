import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { buildServer, isAdminUser, isOperator, sha256Hex, type Env } from "./server";

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
  if (!(await isOperator(request, env))) {
    return new Response("unauthorized: valid operator key required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  return createMcpHandler(buildServer(env, true), { route: "/ops/mcp" })(request, env, ctx);
}

export const defaultHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/ops/mcp") return handleOperatorMcp(request, env, ctx);
    if (url.pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env);
    if (url.pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    return new Response("not found", { status: 404 });
  },
};
