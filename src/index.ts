import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { isAdminUser } from "./auth";
import { runBackup } from "./backup";
import { defaultHandler } from "./github-handler";
import { withSecurityHeaders } from "./headers";
import { buildServer, type Env, type Props } from "./server";

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    if (!props || !isAdminUser(env, props)) {
      return new Response("forbidden: capsid is a single-user server and this grant does not belong to its administrator", {
        status: 403,
      });
    }
    // The admitted GitHub login is the principal for everything this session
    // writes. isAdminUser above has already checked it against
    // ADMIN_GITHUB_LOGIN, so this cannot be an arbitrary caller's claim.
    return createMcpHandler(buildServer(env, true, `github:${props.login}`), { route: "/mcp" })(request, env, ctx);
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

// clientRegistrationTTL is set to the library's own default rather than left to
// it, and the distinction is the point. Dynamic client registration is open by
// necessity (claude.ai's connector UI does DCR and nothing else), so this Worker
// accepts unauthenticated writes into OAUTH_KV at /register, and the only thing
// bounding that keyspace is an expiry. Leaving the bound to a default means it can
// move under us on a patch bump, on a surface where "clients never expire" is a
// one-line change upstream and invisible here.
//
// 90 days is safe for the real clients because every one of them re-registers on
// reconnect: measured 2026-08-13, all 30 live registrations carry an expiry of
// registrationDate plus 90 days, and 22 of the 24 named "Claude" were written in a
// two-hour window on 2026-08-09 during the outage investigation rather than
// accumulating slowly. It also retires that accumulation on its own: those 22
// expire 2026-11-07 whether or not anything reaps them.
//
// This corrects the record. TASK-capsid-audit-2026-08-09.md states the client
// registrations "carry no TTL" and projects roughly 1,460 dead keys a year. They do
// carry one, they always have, and the projection was wrong.
const CLIENT_REGISTRATION_TTL_SECONDS = 90 * 24 * 60 * 60;

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await provider.fetch(request, env, ctx);
    // Both wrappers sit here, at the only point that sees every response: this
    // handler's own, everything github-handler returns, and everything
    // workers-oauth-provider generates for /token, /register and .well-known.
    // Security headers go outside Cache-Control so they are applied to the
    // rebuilt response rather than to one that is about to be replaced.
    return withSecurityHeaders(withCacheDefault(response, new URL(request.url).pathname));
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // A thrown runBackup used to reach nothing but the platform, which records the
    // invocation as failed and keeps the reason to itself. The reason is the only
    // useful part: "the cron failed" is not something anyone can act on, and nobody
    // is watching the cron dashboard daily. Logged here, then rethrown so the
    // invocation still counts as failed.
    ctx.waitUntil(
      runBackup(env)
        .then((result) => {
          if (result.ran && result.prune_refused !== null) {
            console.error(`BACKUP_CRON_REFUSED_PRUNE ${result.prune_refused}`);
          } else if (!result.ran) {
            console.error(`BACKUP_CRON_SKIPPED ${result.skipped}`);
          }
        })
        .catch((err) => {
          console.error(`BACKUP_CRON_THREW ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`);
          throw err;
        })
    );
  },
} satisfies ExportedHandler<Env>;
