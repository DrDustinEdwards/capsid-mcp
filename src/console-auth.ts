import { getCookie, hmacHex, isAdminUser, sha256Hex, timingSafeEqual } from "./auth";
import { b64urlDecode, b64urlEncode } from "./encoding";
import type { Env } from "./env";

// THE CONSOLE'S OWN SESSION, and why it needs one.
//
// The OAuth provider in src/index.ts mints tokens for MCP CLIENTS. There is no
// browser session anywhere in this Worker: /authorize exists to hand a token to
// claude.ai, and the only cookie it leaves is the per-client approval. A human
// opening /console in a browser has nothing to present.
//
// So the console rides the SAME GitHub OAuth app and the SAME admin check
// (isAdminUser against ADMIN_GITHUB_LOGIN), and turns the result into a signed
// cookie. What it deliberately does NOT do is go through the MCP provider: that
// flow ends by redirecting to a registered client redirect_uri with an
// authorization code, which is the wrong shape for a page a person reads.
//
// THE COOKIE IS A SIGNED ASSERTION, NOT A SESSION RECORD. Same construction as the
// approval cookie: an HMAC over a base64url payload, with the login and an expiry
// inside. No server-side session table, so nothing to reap. The cost of that choice
// is stated rather than hidden: a cookie cannot be revoked before it expires, which
// is why the TTL is twelve hours and why the admin check runs again on every request
// rather than being trusted from the payload.

const CONSOLE_SESSION_COOKIE = "capsid_console";
const CONSOLE_STATE_COOKIE = "capsid_console_state";
// Read by the action handler and written by the page render, so it lives with the
// other cookie names rather than in whichever module happened to need it first.
export const CONSOLE_CSRF_COOKIE = "capsid_console_csrf";
export const CONSOLE_SESSION_TTL_SECONDS = 12 * 60 * 60;
const CONSOLE_STATE_TTL_SECONDS = 600;
const CONSOLE_STATE_KV_PREFIX = "capsid:console-state:";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

export interface ConsoleUser {
  login: string;
  id: number | string;
}

interface SessionPayload extends ConsoleUser {
  exp: number;
}

export async function consoleSessionCookie(user: ConsoleUser, secret: string, now: Date): Promise<string> {
  const payload: SessionPayload = {
    login: user.login,
    id: user.id,
    exp: Math.floor(now.getTime() / 1000) + CONSOLE_SESSION_TTL_SECONDS,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(secret, encoded);
  return `${CONSOLE_SESSION_COOKIE}=${sig}.${encoded}; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=${CONSOLE_SESSION_TTL_SECONDS}`;
}

// Returns the session's user, or null for anything that does not verify: no cookie,
// a bad signature, an unreadable payload, an expired one, or a login that is no
// longer the configured admin. That last check is what matters after the fact:
// changing ADMIN_GITHUB_LOGIN invalidates every outstanding console cookie.
export async function readConsoleSession(request: Request, env: Env, now: Date): Promise<ConsoleUser | null> {
  const raw = getCookie(request, CONSOLE_SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const sig = raw.slice(0, dot);
  const encoded = raw.slice(dot + 1);
  if (!timingSafeEqual(sig, await hmacHex(env.COOKIE_ENCRYPTION_KEY, encoded))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded)) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.login !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp * 1000 <= now.getTime()) return null;
  if (!isAdminUser(env, { id: payload.id, login: payload.login })) return null;
  return { login: payload.login, id: payload.id };
}

// ---- the login round trip ----------------------------------------------------

export async function startConsoleLogin(request: Request, env: Env, returnTo: string): Promise<Response> {
  const stateToken = crypto.randomUUID();
  await env.OAUTH_KV.put(`${CONSOLE_STATE_KV_PREFIX}${stateToken}`, returnTo, {
    expirationTtl: CONSOLE_STATE_TTL_SECONDS,
  });
  const origin = new URL(request.url).origin;
  const target = new URL(GITHUB_AUTHORIZE_URL);
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${origin}/console/callback`);
  target.searchParams.set("scope", "read:user");
  target.searchParams.set("state", stateToken);
  const headers = new Headers({ Location: target.href });
  // The state cookie carries a DIGEST of the token, so the cookie alone is not the
  // token. Same construction as the MCP flow's state cookie.
  headers.append(
    "Set-Cookie",
    `${CONSOLE_STATE_COOKIE}=${await sha256Hex(stateToken)}; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=${CONSOLE_STATE_TTL_SECONDS}`
  );
  return new Response(null, { status: 302, headers });
}

function refusal(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain;charset=utf-8" } });
}

export async function handleConsoleCallback(request: Request, env: Env, now: Date): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) return refusal("missing code or state", 400);

  const stateCookie = getCookie(request, CONSOLE_STATE_COOKIE);
  if (!stateCookie || !timingSafeEqual(stateCookie, await sha256Hex(stateToken))) {
    return refusal("state validation failed: this browser did not start the flow. Open /console again.", 403);
  }
  const stateKey = `${CONSOLE_STATE_KV_PREFIX}${stateToken}`;
  const returnTo = await env.OAUTH_KV.get(stateKey);
  if (returnTo === null) return refusal("state expired or already used. Open /console again.", 403);

  const tokenResp = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/console/callback`,
    }),
  });
  if (!tokenResp.ok) return refusal("github token exchange failed", 502);
  const tokenData = (await tokenResp.json()) as { access_token?: string };
  if (!tokenData.access_token) return refusal("github token exchange failed: no access token returned", 502);
  // CONSUMED AFTER THE EXCHANGE, for the reason recorded on the MCP flow: deleting it
  // first means a transient GitHub 502 burns the state, and the reload then reports
  // "expired" for a code GitHub never processed.
  await env.OAUTH_KV.delete(stateKey);

  const userResp = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "capsid",
    },
  });
  if (!userResp.ok) return refusal("failed to fetch github user", 502);
  const user = (await userResp.json()) as { id: number; login: string };
  if (!isAdminUser(env, user)) {
    return refusal(
      `access denied: capsid is a single-user server and GitHub account "${user.login}" is not its administrator`,
      403
    );
  }

  // A relative console path only, checked here rather than trusted from KV: the value
  // was written by this Worker, and treating it as a URL anyway would leave an open
  // redirect one bad write away.
  const safeReturn = returnTo.startsWith("/console") ? returnTo : "/console";
  const headers = new Headers({ Location: safeReturn });
  headers.append("Set-Cookie", await consoleSessionCookie(user, env.COOKIE_ENCRYPTION_KEY, now));
  headers.append("Set-Cookie", `${CONSOLE_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/console; Max-Age=0`);
  return new Response(null, { status: 302, headers });
}
