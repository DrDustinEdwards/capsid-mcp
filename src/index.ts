import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { isAdminUser } from "./auth";
import { runBackup } from "./backup";
import { callerIp, checkRate, dcrRedirectRefusal, REGISTRATION_LIMIT } from "./rate-limit";
import { defaultHandler } from "./routes";
import { mcpOriginProblem, withSecurityHeaders } from "./headers";
import type { Env, Props } from "./env";
import { buildServer } from "./server";
import { chicagoHour } from "./improve-schema";
import { openRuns, tickRuns } from "./improve-run";

// Spelled once. wrangler.jsonc declares them; test/improve-cron.test.ts derives
// one list from the other and fails in both directions.
export const BACKUP_CRON = "0 9 * * *";
export const IMPROVE_OPEN_CRON = "0 8,9 * * *";
export const IMPROVE_TICK_CRON = "*/5 * * * *";

// 03:00 America/Chicago, per the arc.
export const IMPROVE_OPEN_HOUR_CT = 3;

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    if (!props || !isAdminUser(env, props)) {
      return new Response("forbidden: capsid is a single-user server and this grant does not belong to its administrator", {
        status: 403,
      });
    }
    return createMcpHandler(buildServer(env, "write", `github:${props.login}`), { route: "/mcp" })(request, env, ctx);
  },
};

// Fail-closed: every response leaves with no-store unless it asked otherwise.
const CACHE_EXEMPT_PATHS = new Set(["/health"]);

function withCacheDefault(response: Response, pathname: string): Response {
  if (CACHE_EXEMPT_PATHS.has(pathname)) return response;
  if (response.headers.has("Cache-Control")) return response;
  // Headers on an already-constructed Response can be immutable, so rebuild.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const CLIENT_REGISTRATION_TTL_SECONDS = 90 * 24 * 60 * 60;

// The DCR callback receives no env; the fetch handler stashes it.
let currentEnv: Env | null = null;

const CANONICAL_MCP_URL = "https://capsid.dustin-edwards.workers.dev/mcp";

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
  resourceMetadata: { resource: CANONICAL_MCP_URL },
  clientRegistrationCallback: async ({ clientMetadata, request }) => {
    const redirectRefusal = dcrRedirectRefusal(clientMetadata);
    if (redirectRefusal) {
      console.error(`DCR_REDIRECT_REFUSED ${redirectRefusal.description}`);
      return redirectRefusal;
    }

    const env = currentEnv;
    if (!env) {
      console.error("DCR_RATE_LIMIT_UNAVAILABLE env was not available, allowing");
      return;
    }
    const ip = callerIp(request);
    const verdict = await checkRate(env.APP_KV, ip, new Date(), REGISTRATION_LIMIT);
    if (verdict.allowed) return;
    console.error(`DCR_RATE_LIMITED ${ip} hit the ${verdict.window} limit (${verdict.count} of ${verdict.limit})`);
    return {
      code: "access_denied",
      status: 429,
      description: `Too many client registrations from this address: ${verdict.count} in the last ${verdict.window}, limit ${verdict.limit}. Retry later.`,
    };
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    currentEnv = env;
    const pathname = new URL(request.url).pathname;
    if (pathname === "/mcp") {
      const originProblem = mcpOriginProblem(request);
      if (originProblem) {
        return withSecurityHeaders(withCacheDefault(new Response(originProblem, { status: 403 }), pathname));
      }
    }
    const response = await provider.fetch(request, env, ctx);
    return withSecurityHeaders(withCacheDefault(response, pathname));
  },
  // Dispatch on controller.cron, not the clock: 09:00 UTC matches all three
  // expressions and Cloudflare delivers once per expression. Open cron is two
  // UTC hours because 03:00 America/Chicago is 08:00 or 09:00 depending on DST;
  // chicagoHour() picks the real 03:00. Each branch is its own try so a throwing
  // tick cannot stop the backup.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const cron = controller.cron;

    if (cron === BACKUP_CRON) {
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
            console.error(`BACKUP_CRON_THREW ${err instanceof Error ? `${err.message}
${err.stack}` : String(err)}`);
            throw err;
          })
      );
    }

    if (cron === IMPROVE_OPEN_CRON) {
      const now = new Date();
      const hour = chicagoHour(now);
      if (hour !== IMPROVE_OPEN_HOUR_CT) {
        console.log(`IMPROVE_OPEN_SKIPPED local hour is ${hour}, not ${IMPROVE_OPEN_HOUR_CT}`);
      } else {
        ctx.waitUntil(
          openRuns(env, now)
            .then((summary) => {
              console.log(
                `IMPROVE_OPENED mode=${summary.mode} ${summary.outcomes
                  .map((o) => `${o.namespace}:${o.opened ? "opened" : "skipped"}`)
                  .join(" ")}`
              );
            })
            .catch((err) => {
              console.error(`IMPROVE_OPEN_THREW ${err instanceof Error ? `${err.message}
${err.stack}` : String(err)}`);
              throw err;
            })
        );
      }
    }

    if (cron === IMPROVE_TICK_CRON) {
      ctx.waitUntil(
        tickRuns(env, new Date())
          .then((outcomes) => {
            for (const o of outcomes) {
              console.log(`IMPROVE_TICK ${o.runId} ${o.from} -> ${o.to}: ${o.note}`);
            }
          })
          .catch((err) => {
            console.error(`IMPROVE_TICK_THREW ${err instanceof Error ? `${err.message}
${err.stack}` : String(err)}`);
            throw err;
          })
      );
    }
  },
} satisfies ExportedHandler<Env>;
