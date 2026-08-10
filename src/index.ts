import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { isAdminUser } from "./auth";
import { runBackup } from "./backup";
import { defaultHandler } from "./github-handler";
import { buildServer, type Env, type Props } from "./server";

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    if (!props || !isAdminUser(env, props)) {
      return new Response("forbidden: capsid is a single-user server and this grant does not belong to its administrator", {
        status: 403,
      });
    }
    return createMcpHandler(buildServer(env, true), { route: "/mcp" })(request, env, ctx);
  },
};

// Cache-Control is fail-closed: every response leaves with no-store unless it
// explicitly asked for something else. Applied at the outermost exit so it
// covers both handlers and everything workers-oauth-provider generates itself
// (/token, /register, .well-known, its own 401s), which is the only point that
// sees all of them.
//
// This exists because the consent page, which carries a CSRF cookie and a
// single-use approval form, shipped as a 200 text/html with no cache directive
// at all. Under heuristic caching that is a stale-token generator. Measured
// 2026-08-09: /authorize, /health, and .well-known all returned no
// Cache-Control; only the provider's own /mcp 401 set one, and that one is
// preserved here rather than overwritten.
//
// /health is the sole opt-out: it is a liveness probe, it carries nothing
// sensitive, and letting it cache is the point.
const CACHE_EXEMPT_PATHS = new Set(["/health"]);

function withCacheDefault(response: Response, pathname: string): Response {
  if (CACHE_EXEMPT_PATHS.has(pathname)) return response;
  if (response.headers.has("Cache-Control")) return response;
  // Headers on an already-constructed Response can be immutable, so rebuild.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await provider.fetch(request, env, ctx);
    return withCacheDefault(response, new URL(request.url).pathname);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runBackup(env));
  },
} satisfies ExportedHandler<Env>;
